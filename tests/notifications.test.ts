import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Application, defineProvider, type FrameworkError } from '@framework/core';
import { MAILER, Mailer, type MailTransport, MemoryMailTransport } from '@framework/mail';
import { type JobStatus, JobWorker, QUEUE, QueueManager } from '@framework/queue';
import { z } from 'zod/v4';
import type { DeliveryStatus, NotificationChannel } from '../src';
import {
  createNotificationsProvider,
  defineNotification,
  defineNotificationJob,
  InMemoryNotificationStore,
  NOTIFICATION_STORE,
  NOTIFICATIONS,
  NotificationChannelError,
  NotificationStoreError,
  type NotificationsService,
  NotificationValidationError,
  SMS_PLANNED,
} from '../src';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

const from = 'no-reply@example.com';

const welcome = defineNotification({
  name: 'user.welcome',
  channels: ['email', 'database'],
  payload: z.object({ userName: z.string().min(1), message: z.string().optional() }),
  toEmail: (payload) => ({
    subject: `Welcome ${payload.userName}`,
    text: payload.message ?? `Hello ${payload.userName}`,
  }),
  toDatabase: (payload) => ({
    title: `Welcome ${payload.userName}`,
    body: payload.message ?? `Hello ${payload.userName}`,
  }),
});

const databaseOnly = defineNotification({
  name: 'user.internal-note',
  channels: ['database'],
  payload: z.object({ note: z.string().min(1) }),
  toDatabase: (payload) => ({ title: 'Internal note', body: payload.note }),
});

// A transport that never delivers, for the exhausted-retries stack.
const failingTransport: MailTransport = {
  capabilities: { html: true, batch: true },
  send: async () => {
    throw new Error('smtp permanently down');
  },
};

// Fast retries so queued-failure tests settle in milliseconds, not seconds.
const deliveryJob = defineNotificationJob({ attempts: 3, backoffMs: 10 });
const failingDeliveryJob = defineNotificationJob({ attempts: 2, backoffMs: 10 });

const prefix = `notif-test-${crypto.randomUUID()}`;
const manager = new QueueManager({ url: redisUrl, prefix, queue: 'tests' });
const transport = new MemoryMailTransport();
const store = new InMemoryNotificationStore();

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
    createNotificationsProvider({ definitions: [welcome, databaseOnly], job: deliveryJob }),
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

describe('notification envelope', () => {
  test('rejects the planned sms channel as unsupported', async () => {
    const channels = ['sms'] as unknown as NotificationChannel[];
    try {
      await notifications.send({ name: 'user.welcome', channels, to: 'ada@example.com', payload: { userName: 'Ada' } });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationValidationError);
      expect((error as FrameworkError).code).toBe('NOTIFICATION_VALIDATION_FAILED');
      expect((error as NotificationValidationError).fields.some((field) => field.path.startsWith('channels'))).toBe(
        true,
      );
    }
    expect(SMS_PLANNED).toContain('SMS channel is not implemented');
  });

  test('the email channel requires a valid email recipient', async () => {
    try {
      await notifications.send({
        name: 'user.welcome',
        channels: ['email'],
        to: 'definitely-not-an-email',
        payload: { userName: 'Ada' },
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationValidationError);
      expect((error as NotificationValidationError).fields.some((field) => field.path === 'to')).toBe(true);
    }
  });

  test('at least one channel is required', async () => {
    await expect(
      notifications.send({ name: 'user.welcome', channels: [], to: 'ada@example.com', payload: { userName: 'Ada' } }),
    ).rejects.toThrow(NotificationValidationError);
  });

  test('payloads failing the notification schema are rejected before anything runs', async () => {
    await expect(
      notifications.send({ name: 'user.welcome', channels: ['email'], to: 'ada@example.com', payload: {} }),
    ).rejects.toThrow(NotificationValidationError);
  });

  test('unknown notification names are rejected', async () => {
    await expect(
      notifications.send({ name: 'user.nope', channels: ['email'], to: 'ada@example.com', payload: {} }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_UNKNOWN' });
  });
});

describe('inline send (email + database)', () => {
  test('delivers both channels and records per-channel status', async () => {
    const sentBefore = transport.sent().length;
    const status = await notifications.send({
      name: 'user.welcome',
      channels: ['email', 'database'],
      to: 'ada@example.com',
      payload: { userName: 'Ada' },
    });
    expect(status).toMatchObject({ name: 'user.welcome', recipient: 'ada@example.com' });
    expect(status.channels.find((channel) => channel.channel === 'email')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'database')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'email')?.reference).toBeString();

    const sent = transport.sent();
    expect(sent).toHaveLength(sentBefore + 1);
    expect(sent.at(-1)).toMatchObject({ to: ['ada@example.com'], subject: 'Welcome Ada', text: 'Hello Ada' });

    const record = store.records().at(-1);
    expect(record).toMatchObject({ name: 'user.welcome', recipient: 'ada@example.com' });
    expect(record?.database).toMatchObject({ title: 'Welcome Ada', body: 'Hello Ada' });

    const reread = await notifications.status(status.id);
    expect(reread?.channels.map((channel) => channel.state)).toEqual(['delivered', 'delivered']);
  });

  test('a failing email channel does not block the database channel', async () => {
    transport.failNext(new Error('smtp down'));
    const status = await notifications.send({
      name: 'user.welcome',
      channels: ['email', 'database'],
      to: 'grace@example.com',
      payload: { userName: 'Grace' },
    });
    expect(status.channels.find((channel) => channel.channel === 'email')).toMatchObject({
      state: 'failed',
      error: 'smtp down',
    });
    expect(status.channels.find((channel) => channel.channel === 'database')).toMatchObject({ state: 'delivered' });
  });

  test('an un-declared channel is rejected and never fired', async () => {
    const sentBefore = transport.sent().length;
    await expect(
      notifications.send({
        name: 'user.internal-note',
        channels: ['email'],
        to: 'ada@example.com',
        payload: { note: 'hello' },
      }),
    ).rejects.toThrow(NotificationChannelError);
    expect(transport.sent()).toHaveLength(sentBefore);

    const status = await notifications.send({
      name: 'user.internal-note',
      channels: ['database'],
      to: 'user-42',
      payload: { note: 'hello' },
    });
    expect(status.channels).toEqual([expect.objectContaining({ channel: 'database', state: 'delivered' })]);
    expect(transport.sent()).toHaveLength(sentBefore);
  });

  test('unknown ids have no status', async () => {
    expect(await notifications.status('does-not-exist')).toBeNull();
  });
});

describe('queued delivery (BullMQ on real Redis)', () => {
  test('sendQueued dispatches; the worker delivers and completes the job', async () => {
    const sentBefore = transport.sent().length;
    const { id, jobId } = await notifications.sendQueued({
      name: 'user.welcome',
      channels: ['email', 'database'],
      to: 'linus@example.com',
      payload: { userName: 'Linus' },
    });
    expect(id).toBeString();
    expect(jobId).toBeString();

    const status = await settleDelivered(id);
    expect(status.channels.find((channel) => channel.channel === 'email')).toMatchObject({ state: 'delivered' });
    expect(status.channels.find((channel) => channel.channel === 'database')).toMatchObject({ state: 'delivered' });
    expect(transport.sent()).toHaveLength(sentBefore + 1);
    expect(transport.sent().at(-1)).toMatchObject({ to: ['linus@example.com'] });

    const job = await settleJob(jobId, 'completed');
    expect(job.result).toMatchObject({
      recordId: id,
      channels: [
        { channel: 'email', state: 'delivered' },
        { channel: 'database', state: 'delivered' },
      ],
    });
  });

  test('a transient channel failure retries via the queue and ends delivered', async () => {
    // Own stack (unique prefix + own worker and transport) so `failNext` can
    // only ever be consumed by THIS test's delivery — under load, a shared
    // queue lets a previous test's job race the arming and complete on its
    // first attempt instead.
    const transientPrefix = `notif-transient-${crypto.randomUUID()}`;
    const transientTransport = new MemoryMailTransport();
    transientTransport.failNext(new Error('transient smtp failure'));
    const transientManager = new QueueManager({ url: redisUrl, prefix: transientPrefix, queue: 'tests' });
    const transientStore = new InMemoryNotificationStore();
    const transientDeliveryJob = defineNotificationJob({ attempts: 2, backoffMs: 10 });
    const transientApp = new Application({
      config: {},
      providers: [
        defineProvider({
          name: 'mail',
          register({ container }) {
            container.value(MAILER, new Mailer(transientTransport, { from }));
          },
        }),
        defineProvider({
          name: 'queue-test',
          register({ container }) {
            container.value(QUEUE, transientManager);
          },
        }),
        defineProvider({
          name: 'store-test',
          register({ container }) {
            container.value(NOTIFICATION_STORE, transientStore);
          },
        }),
        createNotificationsProvider({ definitions: [welcome], job: transientDeliveryJob }),
      ],
    });
    await transientApp.boot();
    const transientNotifications = transientApp.container.resolve(NOTIFICATIONS);
    const transientWorker = new JobWorker(transientManager, transientApp, [transientDeliveryJob], { concurrency: 1 });
    transientWorker.start();
    try {
      const { id, jobId } = await transientNotifications.sendQueued({
        name: 'user.welcome',
        channels: ['email'],
        to: 'ken@example.com',
        payload: { userName: 'Ken' },
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        const job = await transientManager.status(jobId);
        if (job?.state === 'completed') {
          expect(job.attempts).toBeGreaterThanOrEqual(2);
          break;
        }
        if (Date.now() > deadline) throw new Error(`job ${jobId} did not complete (retries not observed)`);
        await Bun.sleep(25);
      }
      const status = await transientNotifications.status(id);
      expect(status?.channels.find((channel) => channel.channel === 'email')?.state).toBe('delivered');
    } finally {
      await transientWorker.close();
      await transientManager.queue.obliterate({ force: true });
      await transientManager.close();
      await transientApp.shutdown();
    }
  });

  test('exhausted retries end with failed channel status and a failed job', async () => {
    // The worker resolves its services through its own application container,
    // so the failing stack gets its own app, store, queue prefix and worker —
    // exactly how a real worker process would be wired.
    const failingPrefix = `notif-fail-${crypto.randomUUID()}`;
    const failingManager = new QueueManager({ url: redisUrl, prefix: failingPrefix, queue: 'tests' });
    const failingStore = new InMemoryNotificationStore();
    const failingApp = new Application({
      config: {},
      providers: [
        defineProvider({
          name: 'mail',
          register({ container }) {
            container.value(MAILER, new Mailer(failingTransport, { from }));
          },
        }),
        defineProvider({
          name: 'queue-test',
          register({ container }) {
            container.value(QUEUE, failingManager);
          },
        }),
        defineProvider({
          name: 'store-test',
          register({ container }) {
            container.value(NOTIFICATION_STORE, failingStore);
          },
        }),
        createNotificationsProvider({ definitions: [welcome], job: failingDeliveryJob }),
      ],
    });
    await failingApp.boot();
    const failingNotifications = failingApp.container.resolve(NOTIFICATIONS);
    const failingWorker = new JobWorker(failingManager, failingApp, [failingDeliveryJob], { concurrency: 1 });
    failingWorker.start();
    try {
      const { id, jobId } = await failingNotifications.sendQueued({
        name: 'user.welcome',
        channels: ['email'],
        to: 'radia@example.com',
        payload: { userName: 'Radia' },
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const job = await failingManager.status(jobId);
        if (job?.state === 'failed') break;
        if (Date.now() > deadline) throw new Error(`job ${jobId} did not fail`);
        await Bun.sleep(25);
      }
      const status = await failingNotifications.status(id);
      expect(status?.channels.find((channel) => channel.channel === 'email')).toMatchObject({
        state: 'failed',
        error: 'smtp permanently down',
      });
    } finally {
      await failingWorker.close();
      await failingManager.queue.obliterate({ force: true });
      await failingManager.close();
      await failingApp.shutdown();
    }
  });

  test('invalid envelopes are rejected before reaching the queue', async () => {
    const channels = ['sms'] as unknown as NotificationChannel[];
    await expect(
      notifications.sendQueued({ name: 'user.welcome', channels, to: 'ada@example.com', payload: { userName: 'Ada' } }),
    ).rejects.toThrow(NotificationValidationError);
  });
});

describe('notifications provider', () => {
  test('resolution fails with NOTIFICATION_STORE_UNBOUND when the app does not bind a store', async () => {
    const bare = new Application({
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
        createNotificationsProvider(),
      ],
    });
    await bare.boot();
    try {
      let error: unknown;
      try {
        bare.container.resolve(NOTIFICATIONS);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NotificationStoreError);
      expect((error as FrameworkError).code).toBe('NOTIFICATION_STORE_UNBOUND');
    } finally {
      await bare.shutdown();
    }
  });
});
