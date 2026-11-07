import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Mailer, MemoryMailTransport } from '@framework/mail';
import { QueueManager } from '@framework/queue';
import { z } from 'zod/v4';
import {
  defineNotification,
  InMemoryNotificationStore,
  MemorySmsTransport,
  type NotificationChannel,
  NotificationsService,
  smsChannel,
  twilioSms,
  vonageSms,
} from '../src';

const SMS = 'sms' as NotificationChannel;

interface Captured {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, string>;
}

let server: ReturnType<typeof Bun.serve>;
let captured: Captured[] = [];
let respond: () => Response = () => new Response('{}');

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      captured.push({
        url: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: Object.fromEntries(new URLSearchParams(await request.text())),
      });
      return respond();
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const reset = (response: () => Response) => {
  captured = [];
  respond = response;
};
const baseUrl = () => `http://127.0.0.1:${server.port}`;
const message = { to: '+15550100', body: 'Your code is 1234' };

describe('twilioSms', () => {
  const twilio = () =>
    twilioSms({ accountSid: 'AC123', authToken: 'token-value', from: '+15550199', baseUrl: baseUrl() });

  test('posts the message with basic auth and returns its sid', async () => {
    reset(() => Response.json({ sid: 'SM1', status: 'queued' }, { status: 201 }));

    const sent = await twilio().send(message);

    expect(sent).toEqual({ id: 'SM1' });
    expect(captured[0]).toEqual({
      url: '/2010-04-01/Accounts/AC123/Messages.json',
      authorization: `Basic ${btoa('AC123:token-value')}`,
      body: { To: '+15550100', From: '+15550199', Body: 'Your code is 1234' },
    });
  });

  test('a refusal throws the provider message, without the token', async () => {
    reset(() => Response.json({ code: 21211, message: 'Invalid To number' }, { status: 400 }));

    const failure = await twilio()
      .send(message)
      .catch((error: Error) => error);

    expect((failure as Error).message).toContain('Invalid To number');
    expect((failure as Error).message).not.toContain('token-value');
  });

  test('a non-JSON failure still throws', async () => {
    reset(() => new Response('bad gateway', { status: 502 }));

    await expect(twilio().send(message)).rejects.toThrow(/502/);
  });
});

describe('vonageSms', () => {
  const vonage = () => vonageSms({ apiKey: 'key', apiSecret: 'secret-value', from: 'Acme', baseUrl: baseUrl() });

  test('posts the message without the leading plus and returns its id', async () => {
    reset(() => Response.json({ messages: [{ status: '0', 'message-id': 'V1' }] }));

    const sent = await vonage().send(message);

    expect(sent).toEqual({ id: 'V1' });
    expect(captured[0]).toEqual({
      url: '/sms/json',
      authorization: null,
      body: { api_key: 'key', api_secret: 'secret-value', to: '15550100', from: 'Acme', text: 'Your code is 1234' },
    });
  });

  test('a 200 with a failing status throws, because Vonage reports failures that way', async () => {
    reset(() => Response.json({ messages: [{ status: '4', 'error-text': 'Bad Credentials' }] }));

    const failure = await vonage()
      .send(message)
      .catch((error: Error) => error);

    expect((failure as Error).message).toContain('Bad Credentials');
    expect((failure as Error).message).not.toContain('secret-value');
  });

  test('an unexpected response shape throws', async () => {
    reset(() => Response.json({}));

    await expect(vonage().send(message)).rejects.toThrow();
  });
});

describe('timeouts', () => {
  test('a provider that never answers fails instead of hanging', async () => {
    reset(() => new Response('{}'));
    const never = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    await expect(
      twilioSms({ accountSid: 'AC', authToken: 't', from: '+1', timeoutMs: 10, fetch: never }).send(message),
    ).rejects.toThrow();
  });
});

describe('smsChannel', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');
  const manager = new QueueManager({ url: redisUrl, prefix: `sms-${crypto.randomUUID()}`, queue: 'tests' });

  afterAll(() => manager.close());

  const code = defineNotification({
    name: 'login-code',
    channels: [SMS],
    payload: z.object({ code: z.string() }),
    content: { sms: ({ code: value }) => ({ body: `Your code is ${value}` }) },
  });
  const serviceFor = (transport: MemorySmsTransport) =>
    new NotificationsService({
      mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
      queue: manager,
      store: new InMemoryNotificationStore(),
      definitions: [code],
      channels: [smsChannel(transport)],
    });

  test('delivers through the transport and records the reference', async () => {
    const transport = new MemorySmsTransport();

    const status = await serviceFor(transport).send({
      name: 'login-code',
      channels: [SMS],
      to: '+15550100',
      payload: { code: '1234' },
    });

    expect(transport.sent).toEqual([{ to: '+15550100', body: 'Your code is 1234' }]);
    expect(status.channels[0]).toMatchObject({ channel: 'sms', state: 'delivered', reference: 'memory-1' });
  });

  test('a recipient that is not E.164 is recorded as failed and never sent', async () => {
    const transport = new MemorySmsTransport();

    const status = await serviceFor(transport).send({
      name: 'login-code',
      channels: [SMS],
      to: 'not-a-number',
      payload: { code: '1234' },
    });

    expect(transport.sent).toEqual([]);
    expect(status.channels[0]).toMatchObject({ channel: 'sms', state: 'failed' });
  });

  test('sms stays rejected where the channel is not registered', async () => {
    const service = new NotificationsService({
      mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
      queue: manager,
      store: new InMemoryNotificationStore(),
    });

    await expect(service.send({ name: 'x', channels: [SMS], to: '+15550100', payload: {} })).rejects.toThrow();
  });
});
