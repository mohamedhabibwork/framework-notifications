import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Application, ConfigError, defineProvider, type FrameworkError } from '@framework/core';
import { MAILER, Mailer, MemoryMailTransport } from '@framework/mail';
import { type JobStatus, JobWorker, QUEUE, QueueManager } from '@framework/queue';
import { createFakeDriver, type FakeDriver } from '@mohamedhabibwork/notifykit/testing';
import { z } from 'zod/v4';
import type { DeliveryStatus, NotificationChannel } from '../src';
import {
  createNotificationsProvider,
  defineNotification,
  defineNotificationJob,
  InMemoryNotificationStore,
  MESSAGING_PROVIDER_TYPES,
  NOTIFICATION_STORE,
  NOTIFICATIONS,
  NotificationChannelError,
  NotificationDefinitionError,
  NotificationProviderUnavailableError,
  NotificationsService,
  PUSH_PROVIDER_TYPES,
  parseNotificationsProviders,
} from '../src';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

const from = 'no-reply@example.com';

// The notifykit-backed channels: one recording fake serves both kit channels,
// exactly like a production app registers its custom kit drivers once.
const fakeDriver: FakeDriver<{ id: string }> = createFakeDriver<{ id: string }>();

const broadcast = defineNotification({
  name: 'kit.broadcast',
  channels: ['push', 'messaging', 'database'],
  payload: z.object({ message: z.string().min(1) }),
  toDatabase: (payload) => ({ title: 'Broadcast', body: payload.message }),
  toPush: (payload) => ({ title: 'Broadcast', body: `push: ${payload.message}` }),
  toMessaging: (payload) => ({ title: 'Broadcast', body: `messaging: ${payload.message}` }),
});

const pushOnly = defineNotification({
  name: 'kit.device-push',
  channels: ['push'],
  payload: z.object({ message: z.string().min(1) }),
  toPush: (payload) => ({ body: `push: ${payload.message}` }),
});

const welcome = defineNotification({
  name: 'kit.welcome',
  channels: ['email', 'database', 'push'],
  payload: z.object({ userName: z.string().min(1) }),
  toEmail: (payload) => ({ subject: `Welcome ${payload.userName}`, text: `Hello ${payload.userName}` }),
  toDatabase: (payload) => ({ title: `Welcome ${payload.userName}`, body: `Hello ${payload.userName}` }),
  toPush: (payload) => ({ body: `push: Hello ${payload.userName}` }),
});

const deliveryJob = defineNotificationJob({ attempts: 3, backoffMs: 10 });

const prefix = `notif-kit-${crypto.randomUUID()}`;
const manager = new QueueManager({ url: redisUrl, prefix, queue: 'tests' });
const transport = new MemoryMailTransport();
const store = new InMemoryNotificationStore();

const kitProviders = {
  push: { type: 'fake', target: 'id' },
  messaging: { type: 'fake', target: 'id' },
};

const app = new Application({
  config: {},
  providers: [
    defineProvider({
      name: 'mail',
      register({ container }) {
        container.value(MAILER, new Mailer(transport, { from }));
      },
    }),
    defineProvider({
      name: 'queue-test',
      register({ container }) {
        container.value(QUEUE, manager);
      },
    }),
    defineProvider({
      name: 'store-test',
      register({ container }) {
        container.value(NOTIFICATION_STORE, store);
      },
    }),
    createNotificationsProvider({
      definitions: [broadcast, pushOnly, welcome],
      job: deliveryJob,
      providers: kitProviders,
      kitProviders: [fakeDriver],
    }),
  ],
});

let notifications: NotificationsService;
let worker: JobWorker;

async function settleDelivered(id: string, timeoutMs = 10_000): Promise<DeliveryStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await notifications.status(id);
    if (status?.channels.every((channel) => channel.state === 'delivered')) return status;
    if (Date.now() > deadline) {
      throw new Error(`notification ${id} did not settle as delivered: ${JSON.stringify(status)}`);
    }
    await Bun.sleep(25);
  }
}

async function settleJob(jobId: string, state: 'completed' | 'failed', timeoutMs = 10_000): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await manager.status(jobId);
    if (status?.state === state) return status;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach ${state}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  await app.boot();
  notifications = app.container.resolve(NOTIFICATIONS);
  worker = new JobWorker(manager, app, [deliveryJob], { concurrency: 2 });
  worker.start();
});

afterAll(async () => {
  await worker.close();
  await manager.queue.obliterate({ force: true });
  await manager.close();
  await app.shutdown();
});

describe('notifykit-backed channels (push + messaging)', () => {
  test('delivers push and messaging through the fake notifier with the mapped target and records per-channel status', async () => {
    fakeDriver.clear();
    const status = await notifications.send({
      name: 'kit.broadcast',
      channels: ['push', 'messaging', 'database'],
      to: 'device-token-1',
      payload: { message: 'deploy done' },
    });
    expect(status.channels.find((channel) => channel.channel === 'push')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'messaging')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'database')).toMatchObject({ state: 'delivered' });

    // The envelope's string target is delivered under the configured recipient
    // key (`target: 'id'`), the built content maps onto notifykit's
    // notification, and the delivery id is recorded as the channel reference.
    const bodies = fakeDriver.messages().map((message) => message.notification?.body);
    expect(bodies).toContain('push: deploy done');
    expect(bodies).toContain('messaging: deploy done');
    for (const message of fakeDriver.messages()) {
      expect(message.to).toEqual({ id: 'device-token-1' });
      expect(message.idempotencyKey).toStartWith('notification-');
    }
    expect(status.channels.find((channel) => channel.channel === 'push')?.reference).toBeString();
  });

  test('forwards the envelope native passthrough to the kit provider', async () => {
    fakeDriver.clear();
    await notifications.send({
      name: 'kit.device-push',
      channels: ['push'],
      to: 'device-token-2',
      payload: { message: 'with native' },
      native: { ttl: 3600, urgency: 'high' },
    });
    expect(fakeDriver.lastMessage()?.native).toEqual({ ttl: 3600, urgency: 'high' });
  });

  test('a failing push channel does not block the email and database channels', async () => {
    fakeDriver.clear();
    fakeDriver.failNext(new Error('fcm outage'));
    const status = await notifications.send({
      name: 'kit.welcome',
      channels: ['email', 'database', 'push'],
      to: 'grace@example.com',
      payload: { userName: 'Grace' },
    });
    expect(status.channels.find((channel) => channel.channel === 'push')).toMatchObject({
      state: 'failed',
      error: 'fcm outage',
    });
    expect(status.channels.find((channel) => channel.channel === 'email')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'database')).toMatchObject({ state: 'delivered' });
    expect(transport.sent().at(-1)).toMatchObject({ to: ['grace@example.com'] });
  });

  test('an un-declared kit channel is rejected and never fires the provider', async () => {
    fakeDriver.clear();
    await expect(
      notifications.send({
        name: 'kit.device-push',
        channels: ['messaging'],
        to: 'device-token-3',
        payload: { message: 'hello' },
      }),
    ).rejects.toThrow(NotificationChannelError);
    expect(fakeDriver.messages()).toHaveLength(0);
  });

  test('the planned sms channel is still rejected and in no kit catalog', async () => {
    const channels = ['sms'] as unknown as NotificationChannel[];
    await expect(
      notifications.send({ name: 'kit.device-push', channels, to: 'device-token-4', payload: { message: 'x' } }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_VALIDATION_FAILED' });
    expect([...PUSH_PROVIDER_TYPES, ...MESSAGING_PROVIDER_TYPES]).not.toContain('sms');
  });
});

describe('notifykit provider config', () => {
  test('a kit channel without a configured provider fails fast with NOTIFICATION_PROVIDER_UNAVAILABLE', async () => {
    const bareStore = new InMemoryNotificationStore();
    const bare = new NotificationsService({
      mailer: new Mailer(transport, { from }),
      queue: manager,
      store: bareStore,
      definitions: [pushOnly],
      job: deliveryJob,
    });
    try {
      await bare.send({ name: 'kit.device-push', channels: ['push'], to: 'device-token-5', payload: { message: 'x' } });
      throw new Error('expected the send to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationProviderUnavailableError);
      expect((error as FrameworkError).code).toBe('NOTIFICATION_PROVIDER_UNAVAILABLE');
    }
    // Nothing was persisted: the missing provider is caught before the record.
    expect(bareStore.records()).toHaveLength(0);
  });

  test('an unknown provider type fails with NOTIFICATION_PROVIDER_UNAVAILABLE at construction', () => {
    try {
      new NotificationsService({
        mailer: new Mailer(transport, { from }),
        queue: manager,
        store: new InMemoryNotificationStore(),
        providers: { push: { type: 'smsblast' } },
      });
      throw new Error('expected construction to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationProviderUnavailableError);
      expect((error as NotificationProviderUnavailableError).message).toContain('smsblast');
    }
  });

  test('a provider type from the other channel family fails with NOTIFICATION_PROVIDER_UNAVAILABLE', () => {
    try {
      new NotificationsService({
        mailer: new Mailer(transport, { from }),
        queue: manager,
        store: new InMemoryNotificationStore(),
        providers: { messaging: { type: 'fcm' } },
      });
      throw new Error('expected construction to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationProviderUnavailableError);
      expect((error as NotificationProviderUnavailableError).message).toContain('messaging');
    }
  });

  test('a missing provider peer SDK surfaces as NOTIFICATION_PROVIDER_UNAVAILABLE on first kit send', async () => {
    // firebase-admin is not installed in this workspace; notifykit loads it
    // lazily when the fcm notifier is created — the same lazy path production
    // takes — and the framework maps the kit's typed config error onto the
    // catalogued code.
    const fcmApp = new Application({
      config: {},
      providers: [
        defineProvider({
          name: 'mail',
          register({ container }) {
            container.value(MAILER, new Mailer(transport, { from }));
          },
        }),
        defineProvider({
          name: 'queue-test',
          register({ container }) {
            container.value(QUEUE, manager);
          },
        }),
        defineProvider({
          name: 'store-test',
          register({ container }) {
            container.value(NOTIFICATION_STORE, new InMemoryNotificationStore());
          },
        }),
        createNotificationsProvider({
          definitions: [pushOnly],
          providers: {
            push: {
              type: 'fcm',
              options: { credential: { projectId: 'test', clientEmail: 'a@b.c', privateKey: 'k' } },
            },
          },
        }),
      ],
    });
    await fcmApp.boot();
    try {
      const fcmNotifications = fcmApp.container.resolve(NOTIFICATIONS);
      await fcmNotifications.send({
        name: 'kit.device-push',
        channels: ['push'],
        to: 'device-token-6',
        payload: { message: 'x' },
      });
      throw new Error('expected the send to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationProviderUnavailableError);
      expect((error as FrameworkError).code).toBe('NOTIFICATION_PROVIDER_UNAVAILABLE');
      expect((error as Error).message).toContain('firebase-admin');
    } finally {
      await fcmApp.shutdown();
    }
  });

  test('a malformed providers section is a config error', () => {
    expect(() => parseNotificationsProviders({ push: { type: '' } as never })).toThrow(ConfigError);
  });
});

describe('queued delivery with a push channel (BullMQ on real Redis)', () => {
  test('sendQueued dispatches; the worker delivers via the fake and completes the job', async () => {
    fakeDriver.clear();
    const { id, jobId } = await notifications.sendQueued({
      name: 'kit.device-push',
      channels: ['push'],
      to: 'device-token-7',
      payload: { message: 'queued push' },
    });
    const status = await settleDelivered(id);
    expect(status.channels.find((channel) => channel.channel === 'push')).toMatchObject({ state: 'delivered' });
    expect(fakeDriver.lastMessage()?.to).toEqual({ id: 'device-token-7' });
    expect(fakeDriver.lastMessage()?.notification?.body).toBe('push: queued push');

    const job = await settleJob(jobId, 'completed');
    expect(job.result).toMatchObject({
      recordId: id,
      channels: [{ channel: 'push', state: 'delivered' }],
    });

    // Idempotent resume: channels already delivered are never re-sent.
    const sentCount = fakeDriver.messages().length;
    const resumed = await notifications.deliverQueued({
      recordId: id,
      envelope: {
        name: 'kit.device-push',
        channels: ['push'],
        to: 'device-token-7',
        payload: { message: 'queued push' },
      },
      push: { body: 'push: queued push' },
    });
    expect(resumed.channels).toEqual([{ channel: 'push', state: 'delivered' }]);
    expect(fakeDriver.messages()).toHaveLength(sentCount);
  });

  test('a transient push failure retries via the queue and ends delivered', async () => {
    fakeDriver.clear();
    fakeDriver.failNext(new Error('transient apns outage'));
    const { id, jobId } = await notifications.sendQueued({
      name: 'kit.device-push',
      channels: ['push'],
      to: 'device-token-8',
      payload: { message: 'retry push' },
    });
    const status = await settleDelivered(id);
    expect(status.channels.find((channel) => channel.channel === 'push')?.state).toBe('delivered');
    const job = await settleJob(jobId, 'completed');
    expect(job.attempts).toBeGreaterThanOrEqual(2);
    expect(fakeDriver.lastMessage()?.to).toEqual({ id: 'device-token-8' });
  });
});

describe('kit notification definitions', () => {
  test('kit channels without their builder fail at definition time', () => {
    expect(() =>
      defineNotification({
        name: 'kit.bad-push',
        channels: ['push'],
        payload: z.object({ message: z.string() }),
      }),
    ).toThrow(NotificationDefinitionError);
    expect(() =>
      defineNotification({
        name: 'kit.bad-messaging',
        channels: ['messaging'],
        payload: z.object({ message: z.string() }),
      }),
    ).toThrow(/toMessaging builder/);
  });
});
