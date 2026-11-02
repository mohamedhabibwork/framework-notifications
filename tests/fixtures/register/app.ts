/**
 * Compiled by its own `tsc` program (see `registries.test.ts`): augmenting
 * `Register` is global to a program, so it cannot live in the monorepo's.
 */
import type { ExecutionContext } from '@framework/core';
import {
  defineChannel,
  defineNotification,
  type NotificationChannel,
  type NotificationsService,
} from '@framework/notifications';
import { defineJob, type QueueManager } from '@framework/queue';
import { z } from 'zod/v4';

const sendInvoice = defineJob({
  name: 'send-invoice',
  version: 1,
  payload: z.object({ invoiceId: z.string() }),
  handle: async () => null,
});

const resizeImage = defineJob({
  name: 'resize-image',
  version: 1,
  payload: z.object({ width: z.number() }),
  handle: async () => null,
});

const jobs = [sendInvoice, resizeImage] as const;

const welcome = defineNotification({
  name: 'welcome',
  channels: ['email', 'whatsapp'],
  payload: z.object({ userName: z.string() }),
  toEmail: ({ userName }) => ({ subject: `Hi ${userName}`, text: 'Welcome' }),
  content: { whatsapp: ({ userName }) => ({ text: `Hi ${userName}` }) },
});

const notifications = [welcome] as const;

export const whatsapp = defineChannel({
  name: 'whatsapp',
  content: z.object({ text: z.string() }),
  deliver: async (_to, content) => ({ reference: content.text }),
});

declare module '@framework/core' {
  interface Register {
    jobs: typeof jobs;
    notifications: typeof notifications;
    channels: 'whatsapp';
  }
}

export async function useJobs(queue: QueueManager, context: ExecutionContext): Promise<void> {
  await queue.dispatch('send-invoice', { invoiceId: 'i-1' }, context);
  await queue.dispatch(sendInvoice, { invoiceId: 'i-1' }, context);
  // @ts-expect-error unknown job name
  await queue.dispatch('send-invoce', { invoiceId: 'i-1' }, context);
  // @ts-expect-error that payload belongs to send-invoice
  await queue.dispatch('resize-image', { invoiceId: 'i-1' }, context);
}

export async function useNotifications(service: NotificationsService): Promise<void> {
  const channels: readonly NotificationChannel[] = ['email', 'whatsapp'];
  await service.send({ name: 'welcome', channels, to: 'a@example.com', payload: { userName: 'A' } });
  await service.sendQueued({ name: 'welcome', channels, to: 'a@example.com', payload: { userName: 'A' } });
  // @ts-expect-error unknown notification name
  await service.send({ name: 'welcom', channels, to: 'a@example.com', payload: { userName: 'A' } });
  // @ts-expect-error wrong payload
  await service.send({ name: 'welcome', channels, to: 'a@example.com', payload: { user: 'A' } });
}

// @ts-expect-error not a registered channel
export const notAChannel: NotificationChannel = 'carrier-pigeon';
