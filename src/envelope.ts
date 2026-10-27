import type { JsonObject, JsonValue } from '@framework/core';
import { mailAddressSchema } from '@framework/mail';
import { z } from 'zod/v4';
import { NotificationValidationError } from './errors';
import type {
  DatabaseContent,
  EmailContent,
  MessagingContent,
  NotificationEnvelope,
  NotificationFieldError,
  PushContent,
} from './types';

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

const jsonRecord: z.ZodType<JsonObject> = z.record(z.string(), jsonValue);

/**
 * The validated envelope: at least one channel, a recipient, and a JSON
 * payload. The email channel additionally requires `to` to be a valid email
 * address (same address rule as `@framework/mail`); the planned `sms` channel
 * (see `SMS_PLANNED`) and any unknown channel are rejected here. For the
 * `push`/`messaging` channels the envelope stays provider-agnostic: `to` is
 * the string target (device token, chat id, channel id) and `native` is a
 * loosely validated passthrough object forwarded to the notifykit provider —
 * the provider-specific typing lives in `notifications.providers`, never here.
 */
export const notificationEnvelopeSchema: z.ZodType<NotificationEnvelope> = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(255),
    channels: z.array(z.enum(['email', 'database', 'push', 'messaging'])).min(1, 'At least one channel is required'),
    to: z.string().trim().min(1, 'Recipient is required'),
    payload: jsonRecord,
    native: jsonRecord.optional(),
  })
  .refine((envelope) => !envelope.channels.includes('email') || mailAddressSchema.safeParse(envelope.to).success, {
    error: 'The email channel requires a valid email recipient',
    path: ['to'],
  });

/** Email-channel content: subject plus at least one body (same body rule as mail). */
export const emailContentSchema: z.ZodType<EmailContent> = z
  .object({
    subject: z.string().trim().min(1, 'Subject is required').max(998, 'Subject exceeds the 998-character line limit'),
    text: z.string().optional(),
    html: z.string().optional(),
  })
  .refine((content) => content.text !== undefined || content.html !== undefined, {
    error: 'Either a text or an html body is required',
    path: ['body'],
  });

/** Database-channel content: title and body for the application's own row. */
export const databaseContentSchema: z.ZodType<DatabaseContent> = z.object({
  title: z.string().trim().min(1, 'Title is required').max(255),
  body: z.string().min(1, 'Body is required'),
});

/** Push-channel content: body plus optional title, mapped onto notifykit's notification content. */
export const pushContentSchema: z.ZodType<PushContent> = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(255).optional(),
  body: z.string().trim().min(1, 'Body is required'),
});

/** Messaging-channel content: body plus optional title, mapped onto notifykit's notification content. */
export const messagingContentSchema: z.ZodType<MessagingContent> = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(255).optional(),
  body: z.string().trim().min(1, 'Body is required'),
});

/** Maps zod issues to 422-style field errors (same projection as `@framework/mail`). */
export function toNotificationFieldErrors(error: {
  readonly issues: readonly z.core.$ZodIssue[];
}): NotificationFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/** Validates a raw envelope and returns the normalized shape, or throws `NotificationValidationError`. */
export function parseNotificationEnvelope(input: NotificationEnvelope): NotificationEnvelope {
  const result = notificationEnvelopeSchema.safeParse(input);
  if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
  return result.data;
}

/** Validates built email content, or throws `NotificationValidationError`. */
export function parseEmailContent(content: EmailContent): EmailContent {
  const result = emailContentSchema.safeParse(content);
  if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
  return result.data;
}

/** Validates built database content, or throws `NotificationValidationError`. */
export function parseDatabaseContent(content: DatabaseContent): DatabaseContent {
  const result = databaseContentSchema.safeParse(content);
  if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
  return result.data;
}

/** Validates built push content, or throws `NotificationValidationError`. */
export function parsePushContent(content: PushContent): PushContent {
  const result = pushContentSchema.safeParse(content);
  if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
  return result.data;
}

/** Validates built messaging content, or throws `NotificationValidationError`. */
export function parseMessagingContent(content: MessagingContent): MessagingContent {
  const result = messagingContentSchema.safeParse(content);
  if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
  return result.data;
}
