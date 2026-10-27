import { FrameworkError } from '@framework/core';
import type { NotificationChannel, NotificationFieldError } from './types';

/**
 * NOTIFICATION_VALIDATION_FAILED — an envelope or built channel content failed
 * its schema before anything was delivered. Carries 422-style field errors so
 * callers can render each issue.
 */
export class NotificationValidationError extends FrameworkError {
  constructor(readonly fields: readonly NotificationFieldError[]) {
    super('NOTIFICATION_VALIDATION_FAILED', 'The notification is invalid');
  }
}

/**
 * NOTIFICATION_CHANNEL_UNSUPPORTED — the envelope selected a channel the
 * notification definition did not declare. Explicit channel selection only:
 * nothing is delivered to a channel the notification did not declare.
 */
export class NotificationChannelError extends FrameworkError {
  constructor(message: string) {
    super('NOTIFICATION_CHANNEL_UNSUPPORTED', message);
  }
}

/** NOTIFICATION_DEFINITION_INVALID — a notification definition is malformed (no channels, missing builder, duplicate registration). */
export class NotificationDefinitionError extends FrameworkError {
  constructor(message: string) {
    super('NOTIFICATION_DEFINITION_INVALID', message);
  }
}

/** NOTIFICATION_UNKNOWN — no notification record exists for the given id or name. */
export class NotificationUnknownError extends FrameworkError {
  constructor(identifier: string) {
    super('NOTIFICATION_UNKNOWN', `No notification "${identifier}" is known`);
  }
}

/**
 * NOTIFICATION_STORE_UNBOUND — `NOTIFICATION_STORE` must be bound by the
 * application (the framework does not own a notifications table) before the
 * notifications service can be resolved.
 */
export class NotificationStoreError extends FrameworkError {
  constructor(
    message = 'No binding for "notifications.store" — the application must bind NOTIFICATION_STORE to a DatabaseChannelStore implementation before resolving the notifications service',
  ) {
    super('NOTIFICATION_STORE_UNBOUND', message);
  }
}

/**
 * NOTIFICATION_DELIVERY_FAILED — one or more channels failed delivery in the
 * queued path. Per-channel status is already recorded before this is thrown;
 * it is thrown only so `@framework/queue`'s retry policy takes over.
 */
export class NotificationDeliveryError extends FrameworkError {
  constructor(
    id: string,
    readonly failures: readonly { readonly channel: NotificationChannel; readonly message: string }[],
  ) {
    super(
      'NOTIFICATION_DELIVERY_FAILED',
      `Notification "${id}" failed delivery on channel(s): ${failures.map((failure) => failure.channel).join(', ')}`,
    );
  }
}

/**
 * NOTIFICATION_PROVIDER_UNAVAILABLE — the notifykit provider configured for a
 * `push`/`messaging` channel could not be created: the provider type is
 * unknown or belongs to another channel's family, its peer SDK is not
 * installed (notifykit loads provider SDKs lazily), or no provider is
 * configured for a channel the envelope selected. Mirrors storage's
 * `STORAGE_DRIVER_UNAVAILABLE`: a configuration/infrastructure gap, not a
 * delivery outcome, so it propagates instead of being recorded as a failed
 * channel.
 */
export class NotificationProviderUnavailableError extends FrameworkError {
  constructor(message: string, options?: ErrorOptions) {
    super('NOTIFICATION_PROVIDER_UNAVAILABLE', message, options);
  }
}
