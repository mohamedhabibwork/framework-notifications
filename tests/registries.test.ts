import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Mailer, MemoryMailTransport } from '@framework/mail';
import { jobEnvelopeOf, QueueManager } from '@framework/queue';
import { z } from 'zod/v4';
import {
  defineChannel,
  defineNotification,
  InMemoryNotificationStore,
  type NotificationChannel,
  NotificationChannelError,
  NotificationDefinitionError,
  NotificationDeliveryError,
  NotificationsService,
  NotificationValidationError,
  notificationJobPayloadSchema,
} from '../src';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

const FIXTURE = join(import.meta.dir, 'fixtures/register');
const WHATSAPP = 'whatsapp' as NotificationChannel;
const SMS = 'sms' as NotificationChannel;

const manager = new QueueManager({ url: redisUrl, prefix: `registries-${crypto.randomUUID()}`, queue: 'tests' });

afterAll(async () => {
  await manager.queue.obliterate({ force: true });
  await manager.close();
});

type Sent = { readonly to: string; readonly text: string };

const whatsappChannel = (sent: Sent[], fail = false) =>
  defineChannel({
    name: 'whatsapp',
    content: z.object({ text: z.string().min(1) }),
    deliver: async (to, content) => {
      if (fail) throw new Error('whatsapp is down');
      sent.push({ to, text: content.text });
      return { reference: 'wa-1' };
    },
  });

const greeting = defineNotification({
  name: 'greeting',
  channels: ['database', WHATSAPP],
  payload: z.object({ userName: z.string() }),
  toDatabase: ({ userName }) => ({ title: 'Hi', body: userName }),
  content: { whatsapp: ({ userName }) => ({ text: `Hi ${userName}` }) },
});

const serviceWith = (channel: ReturnType<typeof whatsappChannel>, store = new InMemoryNotificationStore()) =>
  new NotificationsService({
    mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
    queue: manager,
    store,
    definitions: [greeting],
    channels: [channel],
  });

const send = { name: 'greeting', channels: [WHATSAPP], to: '+15550100', payload: { userName: 'Ada' } };

describe('custom notification channels', () => {
  test('delivers through the channel and records its reference', async () => {
    const sent: Sent[] = [];

    const status = await serviceWith(whatsappChannel(sent)).send(send);

    expect(sent).toEqual([{ to: '+15550100', text: 'Hi Ada' }]);
    expect(status.channels).toMatchObject([{ channel: 'whatsapp', state: 'delivered', reference: 'wa-1' }]);
  });

  test('a failing channel is recorded and does not block the others', async () => {
    const status = await serviceWith(whatsappChannel([], true)).send({ ...send, channels: ['database', WHATSAPP] });

    expect(status.channels).toContainEqual(
      expect.objectContaining({ channel: 'whatsapp', state: 'failed', error: 'whatsapp is down' }),
    );
    expect(status.channels).toContainEqual(expect.objectContaining({ channel: 'database', state: 'delivered' }));
  });

  test('validates built content against the channel schema', async () => {
    const empty = defineNotification({
      name: 'empty',
      channels: [WHATSAPP],
      payload: z.object({}),
      content: { whatsapp: () => ({ text: '' }) },
    });
    const service = new NotificationsService({
      mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
      queue: manager,
      store: new InMemoryNotificationStore(),
      definitions: [empty],
      channels: [whatsappChannel([])],
    });

    await expect(service.send({ name: 'empty', channels: [WHATSAPP], to: 'x', payload: {} })).rejects.toBeInstanceOf(
      NotificationValidationError,
    );
  });

  test('queued delivery carries the content across the job boundary and resumes', async () => {
    const sent: Sent[] = [];
    const store = new InMemoryNotificationStore();
    const service = serviceWith(whatsappChannel(sent), store);
    const { id, jobId } = await service.sendQueued(send);
    const job = await manager.queue.getJob(jobId);
    if (!job) throw new Error('job was not enqueued');
    const payload = notificationJobPayloadSchema.parse(jobEnvelopeOf(job.data).payload);

    const result = await service.deliverQueued(payload);
    await service.deliverQueued(payload);

    expect(result.channels).toEqual([{ channel: WHATSAPP, state: 'delivered' }]);
    expect(sent).toHaveLength(1);
    expect((await service.status(id))?.channels[0]?.reference).toBe('wa-1');
  });

  test('a queued failure is retried by the queue', async () => {
    const service = serviceWith(whatsappChannel([], true));
    const { id } = await service.sendQueued(send);

    await expect(
      service.deliverQueued({ recordId: id, envelope: send, custom: { whatsapp: { text: 'Hi' } } }),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
  });

  test('a queued envelope naming a channel this process lacks never counts as delivered', async () => {
    const store = new InMemoryNotificationStore();
    const service = serviceWith(whatsappChannel([]), store);
    const { id } = await store.store({ name: 'greeting', recipient: 'x', channels: [SMS], payload: {} });

    await expect(
      service.deliverQueued({ recordId: id, envelope: { ...send, channels: [SMS] } }),
    ).rejects.toBeInstanceOf(NotificationChannelError);
    expect((await store.status(id))?.channels[0]?.state).toBe('pending');
  });

  test('an unregistered channel is still rejected at validation', async () => {
    await expect(serviceWith(whatsappChannel([])).send({ ...send, channels: [SMS] })).rejects.toBeInstanceOf(
      NotificationValidationError,
    );
  });

  test('a definition using a channel nobody registered fails at construction', () => {
    expect(
      () =>
        new NotificationsService({
          mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
          queue: manager,
          store: new InMemoryNotificationStore(),
          definitions: [greeting],
        }),
    ).toThrow(NotificationDefinitionError);
  });

  test('a channel cannot be registered twice', () => {
    expect(
      () =>
        new NotificationsService({
          mailer: new Mailer(new MemoryMailTransport(), { from: 'no-reply@example.com' }),
          queue: manager,
          store: new InMemoryNotificationStore(),
          channels: [whatsappChannel([]), whatsappChannel([])],
        }),
    ).toThrow(NotificationDefinitionError);
  });
});

describe('definitions', () => {
  test('defineChannel refuses a built-in name', () => {
    expect(() => defineChannel({ name: 'email', content: z.object({}), deliver: async () => undefined })).toThrow(
      NotificationDefinitionError,
    );
  });

  test('defineNotification needs a content builder for a custom channel', () => {
    expect(() => defineNotification({ name: 'no-builder', channels: [WHATSAPP], payload: z.object({}) })).toThrow(
      NotificationDefinitionError,
    );
  });
});

describe('Register augmentation', () => {
  test('jobs, notifications, channels and events are checked against Register', async () => {
    const typecheck = Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'], {
      cwd: FIXTURE,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(typecheck.stdout).text(),
      new Response(typecheck.stderr).text(),
      typecheck.exited,
    ]);

    expect(`${code}: ${stdout}${stderr}`).toBe('0: ');
  }, 120_000);
});
