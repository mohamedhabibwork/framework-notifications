import { defineJob, type JobContext, type JobDefinition } from '@framework/queue';
import { z } from 'zod/v4';
import { NOTIFICATIONS } from './constants';
import {
  databaseContentSchema,
  emailContentSchema,
  messagingContentSchema,
  notificationEnvelopeSchema,
  pushContentSchema,
} from './envelope';
import type { NotificationJobOptions, NotificationJobPayload, NotificationJobResult } from './types';

/** Identity of the built-in delivery job on the queue. */
export const NOTIFICATION_JOB_NAME = 'notifications.deliver';
export const NOTIFICATION_JOB_VERSION = 1;

/**
 * Versioned, validated payload of the delivery job: the record id, the
 * validated envelope, and the channel content built at dispatch time (so what
 * was queued is exactly what gets delivered, even across deploys).
 */
export const notificationJobPayloadSchema: z.ZodType<NotificationJobPayload> = z
  .object({
    recordId: z.string().min(1, 'Record id is required'),
    envelope: notificationEnvelopeSchema,
    email: emailContentSchema.optional(),
    database: databaseContentSchema.optional(),
    push: pushContentSchema.optional(),
    messaging: messagingContentSchema.optional(),
  })
  .refine((payload) => !payload.envelope.channels.includes('email') || payload.email !== undefined, {
    error: 'The email channel content is required when the email channel is selected',
    path: ['email'],
  })
  .refine((payload) => !payload.envelope.channels.includes('database') || payload.database !== undefined, {
    error: 'The database channel content is required when the database channel is selected',
    path: ['database'],
  })
  .refine((payload) => !payload.envelope.channels.includes('push') || payload.push !== undefined, {
    error: 'The push channel content is required when the push channel is selected',
    path: ['push'],
  })
  .refine((payload) => !payload.envelope.channels.includes('messaging') || payload.messaging !== undefined, {
    error: 'The messaging channel content is required when the messaging channel is selected',
    path: ['messaging'],
  });

/**
 * The `@framework/queue` job that delivers a notification record on the
 * worker. Register it on the application's `JobWorker`; `sendQueued`
 * dispatches it. Retries (attempts/backoff) ride the queue's retry policy —
 * the handler only records per-channel outcomes and throws
 * `NOTIFICATION_DELIVERY_FAILED` when a channel still fails, which is what
 * triggers the next attempt.
 */
export function defineNotificationJob(
  options: NotificationJobOptions = {},
): JobDefinition<NotificationJobPayload, NotificationJobResult> {
  return defineJob({
    name: options.name ?? NOTIFICATION_JOB_NAME,
    version: options.version ?? NOTIFICATION_JOB_VERSION,
    payload: notificationJobPayloadSchema,
    attempts: options.attempts ?? 3,
    backoffMs: options.backoffMs ?? 5_000,
    // One delivery record maps to one queue job; duplicate dispatches collapse.
    idempotencyKey: (payload) => `notification-${payload.recordId}`,
    // The handler resolves the service through the job scope, so the payload
    // carries no app code and workers stay decoupled from producers.
    async handle(payload, context: JobContext) {
      return context.scope.resolve(NOTIFICATIONS).deliverQueued(payload);
    },
  });
}
