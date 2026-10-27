/**
 * Every interface and type alias of `@framework/notifications` in one place.
 * Runtime values (classes, tokens, functions, schemas) live in their modules.
 */
import type { ExecutionContext, JsonObject } from '@framework/core';
import type { Mailer } from '@framework/mail';
import type { JobDefinition, QueueManager } from '@framework/queue';
import type { NotificationDriverDefinition } from '@mohamedhabibwork/notifykit';
import type { z } from 'zod/v4';

// -- Channels ------------------------------------------------------------------

/**
 * Delivery channels. SMS is planned but deliberately not implemented (see
 * `SMS_PLANNED`); nothing is ever delivered to a channel the notification did
 * not declare (spec §8).
 *
 * - `email` delivers through the bound `@framework/mail` `Mailer` — the mail
 *   transport stays owned by `@framework/mail` (notifykit's SMTP provider is
 *   deliberately NOT adopted).
 * - `database` persists through the application-owned `DatabaseChannelStore`.
 * - `push` and `messaging` delegate to `@mohamedhabibwork/notifykit` providers
 *   configured under `notifications.providers` (see
 *   {@link NotificationsProvidersConfig}): `push` targets device-push
 *   providers (`fcm`, `apns`, `webpush`, `huawei`), `messaging` targets
 *   messaging providers (`telegram`, `slack`). Provider SDKs are optional
 *   peers loaded lazily by notifykit — see `PUSH_PROVIDER_TYPES` /
 *   `MESSAGING_PROVIDER_TYPES`.
 */
export type NotificationChannel = 'email' | 'database' | 'push' | 'messaging';

/** Channels whose engine is a notifykit provider (config under `notifications.providers`). */
export type KitChannel = Extract<NotificationChannel, 'push' | 'messaging'>;

// -- Built content ---------------------------------------------------------------

/** Content the `toEmail` builder produces for the email channel; at least one body is required. */
export type EmailContent = {
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
};

/** Content the `toDatabase` builder produces for the database channel. */
export type DatabaseContent = {
  readonly title: string;
  readonly body: string;
};

/**
 * Content the `toPush` builder produces for the push channel; mapped onto
 * notifykit's `notification` content (`title`/`body`) for the configured
 * device-push provider (`fcm`, `apns`, `webpush`, `huawei`).
 */
export type PushContent = {
  readonly title?: string;
  readonly body: string;
};

/**
 * Content the `toMessaging` builder produces for the messaging channel;
 * mapped onto notifykit's `notification` content for the configured messaging
 * provider (`telegram`, `slack`).
 */
export type MessagingContent = {
  readonly title?: string;
  readonly body: string;
};

// -- Envelope ------------------------------------------------------------------

/**
 * The validated, serializable notification envelope — the only shape that
 * crosses process boundaries (inline send uses it directly, queued delivery
 * embeds it in the job payload). `to` must be a valid email address when the
 * email channel is selected; database-only recipients may be any identifier.
 *
 * The provider-agnostic recipient for `push`/`messaging` is the string `to`
 * (device token, chat id, channel id — the app decides), wrapped into the
 * provider's recipient by the engine (see `NotificationProviderConfig.target`).
 * `native` is a loosely validated passthrough object forwarded verbatim as
 * notifykit's per-send `native` options (`parse_mode`, TTL, blocks, ...) and
 * is only read by the `push`/`messaging` channels — provider-specific typing
 * lives in the provider config, never in this envelope.
 */
export type NotificationEnvelope = {
  readonly name: string;
  readonly channels: readonly NotificationChannel[];
  readonly to: string;
  readonly payload: JsonObject;
  readonly native?: JsonObject;
};

// -- Delivery status --------------------------------------------------------------

/** Lifecycle of one channel of one notification: `pending -> delivered | failed`. */
export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** Per-channel delivery status of one notification record. */
export interface ChannelStatus {
  readonly channel: NotificationChannel;
  readonly state: DeliveryState;
  /** Transport-provided delivery id (sent message id) when delivered. */
  readonly reference?: string;
  /** Failure message when failed. */
  readonly error?: string;
  /** ISO timestamp of the last transition. */
  readonly updatedAt?: string;
}

/** The delivery status contract: what `NotificationsService.status(id)` and the store return. */
export interface DeliveryStatus {
  readonly id: string;
  readonly name: string;
  readonly recipient: string;
  readonly channels: readonly ChannelStatus[];
  /** ISO timestamp of record creation. */
  readonly createdAt: string;
}

// -- Store ---------------------------------------------------------------------

/**
 * One notification record the store persists — the application's own schema decides the table shape.
 */
export interface NotificationRecordInput {
  readonly name: string;
  readonly recipient: string;
  readonly channels: readonly NotificationChannel[];
  readonly payload: JsonObject;
  /** Built email content; present when the email channel was selected. */
  readonly email?: EmailContent;
  /** Built database content; present when the database channel was selected. */
  readonly database?: DatabaseContent;
  /** Built push content; present when the push channel was selected. */
  readonly push?: PushContent;
  /** Built messaging content; present when the messaging channel was selected. */
  readonly messaging?: MessagingContent;
}

/**
 * The application-implemented seam behind the database channel AND the
 * delivery-status ledger. The framework does NOT own a table: `store`
 * persists the record in the application's own schema and seeds pending
 * status per declared channel, `markDelivered`/`markFailed` transition one
 * channel, and `status` reads a record back. Retry contracts ride the queue
 * (`@framework/queue`); the store only records outcomes.
 */
export interface DatabaseChannelStore {
  /** Persist one notification record, seeding `pending` per channel; returns its id. */
  store(record: NotificationRecordInput): Promise<{ id: string }>;
  /** Marks one channel delivered, optionally with the transport's delivery id. */
  markDelivered(id: string, channel: NotificationChannel, reference?: string): Promise<void>;
  /** Marks one channel failed with the error message that caused it. */
  markFailed(id: string, channel: NotificationChannel, message: string): Promise<void>;
  /** The delivery status of one record, or null when unknown. */
  status(id: string): Promise<DeliveryStatus | null>;
}

// -- Definitions ------------------------------------------------------------------

/** Per-field validation error (422-style); mirrors `@framework/mail`'s `MailFieldError`. */
export interface NotificationFieldError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/**
 * An app-defined notification: which channels it may ever use, how to
 * validate its payload, and one content builder per declared channel.
 * Channel selection happens per send via the envelope; a builder must exist
 * for every declared channel (checked by `defineNotification`).
 */
export interface NotificationDefinition<TPayload extends JsonObject = JsonObject> {
  readonly name: string;
  /** Every channel this notification may be delivered through, ever. */
  readonly channels: readonly NotificationChannel[];
  /** Validates the envelope payload before any builder runs. */
  readonly payload: z.ZodType<TPayload>;
  /** Required when `channels` includes `email`. */
  toEmail?(payload: TPayload): EmailContent;
  /** Required when `channels` includes `database`. */
  toDatabase?(payload: TPayload): DatabaseContent;
  /** Required when `channels` includes `push`. */
  toPush?(payload: TPayload): PushContent;
  /** Required when `channels` includes `messaging`. */
  toMessaging?(payload: TPayload): MessagingContent;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous definitions erased to one runtime shape (same pattern as queue's JobList)
export type AnyNotificationDefinition = NotificationDefinition<any>;

// -- Queued delivery ---------------------------------------------------------------

/** Versioned, validated payload of the built-in delivery job (see ./job). */
export type NotificationJobPayload = {
  readonly recordId: string;
  readonly envelope: NotificationEnvelope;
  readonly email?: EmailContent;
  readonly database?: DatabaseContent;
  readonly push?: PushContent;
  readonly messaging?: MessagingContent;
};

/** JSON-safe result of the built-in delivery job. */
export type NotificationJobResult = {
  readonly recordId: string;
  readonly channels: readonly { readonly channel: NotificationChannel; readonly state: DeliveryState }[];
};

export interface NotificationJobOptions {
  readonly name?: string;
  readonly version?: number;
  /** Attempts before the job is parked as failed (default 3). */
  readonly attempts?: number;
  /** Backoff between attempts in ms (default 5000). */
  readonly backoffMs?: number;
}

// -- Service / provider options ------------------------------------------------

/**
 * Configuration entry for one notifykit provider (the `notifications.providers`
 * section). Only channels the application declares carry an entry; a send to a
 * kit channel without one fails with `NOTIFICATION_PROVIDER_UNAVAILABLE`.
 *
 * `type` is a notifykit provider name: device-push (`fcm`, `apns`, `webpush`,
 * `huawei`) for the `push` channel, messaging (`telegram`, `slack`) for the
 * `messaging` channel (see `PUSH_PROVIDER_TYPES` / `MESSAGING_PROVIDER_TYPES`).
 * Provider SDKs (`firebase-admin`, `web-push`, `@parse/node-apn`) are optional
 * peers loaded lazily by notifykit when the notifier is created — a missing
 * peer or an unknown type surfaces as `NOTIFICATION_PROVIDER_UNAVAILABLE`, not
 * as a config error. `options` is forwarded verbatim to notifykit's
 * `createNotifier` and is that provider's own contract (same pass-through as
 * `@framework/storage`'s kit options).
 */
export interface NotificationProviderConfig {
  /** The notifykit provider powering the channel. */
  readonly type: string;
  /**
   * The notifykit recipient key the envelope's string target is delivered as.
   * Built-in types have documented defaults (`fcm`/`huawei` → `token`,
   * `apns` → `deviceToken`, `webpush` → `endpoint`, `telegram` → `chatId`,
   * `slack` → `channel`); custom kit providers (e.g. notifykit's testing
   * fake) must name theirs.
   */
  readonly target?: string;
  /** Pass-through options for notifykit's `createNotifier` (botToken, credential, vapid, ...). */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** The `notifications.providers` config section: one provider per kit channel. */
export interface NotificationsProvidersConfig {
  /** Provider for the `push` channel (fcm/apns/webpush/huawei). */
  readonly push?: NotificationProviderConfig;
  /** Provider for the `messaging` channel (telegram/slack). */
  readonly messaging?: NotificationProviderConfig;
}

/**
 * A custom notifykit driver definition (e.g. notifykit's testing fake) passed
 * through to `createNotifier` so the production construction path runs
 * unchanged against a recording fake. Generics are erased: the framework
 * treats every notifier uniformly, exactly like storage treats kit drivers.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous kit drivers erased to one runtime shape (same pattern as queue's JobList)
export type KitNotificationDriver = NotificationDriverDefinition<string, any, any, any, any>;

export interface NotificationsServiceOptions {
  readonly mailer: Mailer;
  readonly store: DatabaseChannelStore;
  readonly queue: QueueManager;
  /** Registered app notifications; looked up by envelope `name`. */
  readonly definitions?: readonly AnyNotificationDefinition[];
  /** The queue job `sendQueued` dispatches; defaults to `defineNotificationJob()`. */
  readonly job?: JobDefinition<NotificationJobPayload, NotificationJobResult>;
  /**
   * The `notifications.providers` section: the notifykit provider backing each
   * kit channel (`push`/`messaging`). Optional — existing email/database-only
   * apps need none; a send selecting a kit channel without its provider fails
   * with `NOTIFICATION_PROVIDER_UNAVAILABLE`.
   */
  readonly providers?: NotificationsProvidersConfig;
  /** Custom notifykit driver definitions passed through to `createNotifier` (notifykit's testing fake, app-registered custom providers). */
  readonly kitProviders?: readonly KitNotificationDriver[];
}

export interface NotificationsProviderOptions {
  readonly definitions?: readonly AnyNotificationDefinition[];
  readonly job?: JobDefinition<NotificationJobPayload, NotificationJobResult>;
  /** The `notifications.providers` section (see {@link NotificationsServiceOptions.providers}). */
  readonly providers?: NotificationsProvidersConfig;
  /** Custom notifykit driver definitions passed through to `createNotifier`. */
  readonly kitProviders?: readonly KitNotificationDriver[];
}

export interface SendQueuedOptions {
  /** Overrides the ambient execution context for actor/correlation attribution on the queue job. */
  readonly execution?: ExecutionContext;
  readonly delayMs?: number;
  /** Overrides the job definition's attempt count for this dispatch. */
  readonly attempts?: number;
}

import type { NotificationsService } from './service';

/** The `NotificationsService` class (see ./service) is both implementation and public contract. */
export type { NotificationsService };
