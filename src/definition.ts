import type { JsonObject } from '@framework/core';
import { NotificationDefinitionError } from './errors';
import type { NotificationDefinition } from './types';

/**
 * Identity helper that validates a notification definition up front, so a
 * missing builder for a declared channel fails at definition time instead of
 * at first delivery. Channel selection itself happens per send via the
 * envelope; this only guarantees every declared channel is deliverable.
 */
export function defineNotification<TPayload extends JsonObject>(
  definition: NotificationDefinition<TPayload>,
): NotificationDefinition<TPayload> {
  const { name, channels } = definition;
  if (channels.length === 0) {
    throw new NotificationDefinitionError(`Notification "${name}" declares no channels`);
  }
  if (new Set(channels).size !== channels.length) {
    throw new NotificationDefinitionError(`Notification "${name}" declares duplicate channels`);
  }
  if (channels.includes('email') && !definition.toEmail) {
    throw new NotificationDefinitionError(
      `Notification "${name}" declares the email channel without a toEmail builder`,
    );
  }
  if (channels.includes('database') && !definition.toDatabase) {
    throw new NotificationDefinitionError(
      `Notification "${name}" declares the database channel without a toDatabase builder`,
    );
  }
  if (channels.includes('push') && !definition.toPush) {
    throw new NotificationDefinitionError(`Notification "${name}" declares the push channel without a toPush builder`);
  }
  if (channels.includes('messaging') && !definition.toMessaging) {
    throw new NotificationDefinitionError(
      `Notification "${name}" declares the messaging channel without a toMessaging builder`,
    );
  }
  return definition;
}
