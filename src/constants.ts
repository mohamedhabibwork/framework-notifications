/**
 * Constants of `@framework/notifications`: dependency-injection tokens, the
 * notifykit provider catalogs per kit channel, and the SMS planning note.
 */
import { token } from '@framework/core';
import type { DatabaseChannelStore, NotificationsService } from './types';

/** The notifications service (inline + queued delivery, status reads). */
export const NOTIFICATIONS = token<NotificationsService>('notifications.service');

/**
 * The application-owned notification store (database channel rows + delivery
 * status). The framework deliberately does NOT bind it: applications bind
 * their own `DatabaseChannelStore` implementation; resolving `NOTIFICATIONS`
 * without it fails with `NOTIFICATION_STORE_UNBOUND`.
 */
export const NOTIFICATION_STORE = token<DatabaseChannelStore>('notifications.store');

/**
 * Device-push provider types notifykit ships for the `push` channel
 * (`notifications.providers.push`). `fcm`, `webpush` and `apns` need their
 * peer SDK (`firebase-admin`, `web-push`, `@parse/node-apn`) installed and
 * load it lazily when the notifier is created; `huawei` is fetch-based.
 */
export const PUSH_PROVIDER_TYPES = ['fcm', 'apns', 'webpush', 'huawei'] as const;

/**
 * Messaging provider types notifykit ships for the `messaging` channel
 * (`notifications.providers.messaging`). Both are fetch-based — no peer SDK.
 */
export const MESSAGING_PROVIDER_TYPES = ['telegram', 'slack'] as const;

/**
 * The notifykit recipient key each built-in provider type receives the
 * envelope's string target as (see `NotificationProviderConfig.target`).
 */
export const KIT_DEFAULT_TARGETS: Readonly<Record<string, string>> = {
  fcm: 'token',
  huawei: 'token',
  apns: 'deviceToken',
  webpush: 'endpoint',
  telegram: 'chatId',
  slack: 'channel',
};

/**
 * SMS_PLANNED — the SMS channel is deliberately not implemented. Spec §8
 * requires real-transport integration tests to prove provider behavior, so a
 * real SMS dependency has to be chosen first; none is bundled. The envelope
 * schema rejects any channel outside `email` | `database` | `push` |
 * `messaging` until then.
 */
export const SMS_PLANNED =
  'notifications: the SMS channel is not implemented — planned until an SMS dependency is chosen; channels are `email`, `database`, `push` and `messaging` only' as const;
