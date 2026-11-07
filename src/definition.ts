import type { JsonObject } from '@framework/core';
import { BUILT_IN_NOTIFICATION_CHANNELS } from './constants';
import { NotificationDefinitionError } from './errors';
import type { AnyNotificationDefinition, NotificationChannelDefinition, NotificationDefinition } from './types';

const CHANNEL_NAME = /^[a-z][a-z0-9_-]*$/;

/** Fails when a declared channel could never be delivered. */
export function assertDeliverable(definition: AnyNotificationDefinition): void {
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
  for (const channel of channels) {
    if (BUILT_IN_NOTIFICATION_CHANNELS.includes(channel)) continue;
    if (!definition.content || !Object.hasOwn(definition.content, channel)) {
      throw new NotificationDefinitionError(
        `Notification "${name}" declares the ${channel} channel without a content builder`,
      );
    }
  }
}

/**
 * Identity helper that validates a notification definition up front, so a
 * missing builder for a declared channel fails at definition time instead of
 * at first delivery. Channel selection itself happens per send via the
 * envelope; this only guarantees every declared channel is deliverable.
 */
export function defineNotification<TPayload extends JsonObject, const TName extends string = string>(
  definition: NotificationDefinition<TPayload, TName>,
): NotificationDefinition<TPayload, TName> {
  assertDeliverable(definition);
  return definition;
}

/**
 * Declares a delivery channel beyond the built-in ones. A notification uses it
 * by listing its name in `channels` with a builder under `content`, and the
 * service delivers through it once it is passed as `channels`. It gets the same
 * record, per-channel status and queued retries as the built-in channels.
 */
export function defineChannel<const TName extends string, TContent extends JsonObject>(
  channel: NotificationChannelDefinition<TName, TContent>,
): NotificationChannelDefinition<TName, TContent> {
  if (BUILT_IN_NOTIFICATION_CHANNELS.includes(channel.name)) {
    throw new NotificationDefinitionError(`Channel "${channel.name}" is built in and cannot be redefined`);
  }
  if (!CHANNEL_NAME.test(channel.name)) {
    throw new NotificationDefinitionError(
      `Channel "${channel.name}" must start with a lowercase letter and use lowercase letters, digits, "-" or "_"`,
    );
  }
  return channel;
}
