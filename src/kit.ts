/**
 * The notifykit engine behind the `push` and `messaging` channels (spec §8
 * adaptation): providers are declared under `notifications.providers`, and
 * notifiers are created through notifykit's `createNotifier` — the same
 * construction path real applications and notifykit's testing fake take.
 *
 * Capability honesty: the framework supports exactly the provider types
 * notifykit ships per channel (`PUSH_PROVIDER_TYPES`, `MESSAGING_PROVIDER_TYPES`).
 * Provider SDKs (`firebase-admin`, `web-push`, `@parse/node-apn`) are optional
 * peers loaded lazily by notifykit when the notifier is created; a missing
 * peer, an unknown type, or a type from the other channel's family surfaces as
 * `NOTIFICATION_PROVIDER_UNAVAILABLE` (same treatment as storage's
 * `STORAGE_DRIVER_UNAVAILABLE`). The `email` channel deliberately does NOT go
 * through notifykit — mail transport stays owned by `@framework/mail` and
 * notifykit's SMTP provider is not adopted; SMS stays planned.
 */

import { ConfigError } from '@framework/core';
import {
  createNotifier,
  NotificationConfigError,
  type NotificationMessage,
  type Notifier,
} from '@mohamedhabibwork/notifykit';
import { z } from 'zod/v4';
import { KIT_DEFAULT_TARGETS, MESSAGING_PROVIDER_TYPES, PUSH_PROVIDER_TYPES } from './constants';
import { NotificationProviderUnavailableError } from './errors';
import type {
  KitChannel,
  KitNotificationDriver,
  NotificationEnvelope,
  NotificationProviderConfig,
  NotificationsProvidersConfig,
} from './types';

/** The channel family each notifykit provider type belongs to. */
const CHANNEL_PROVIDERS: Readonly<Record<KitChannel, readonly string[]>> = {
  push: PUSH_PROVIDER_TYPES,
  messaging: MESSAGING_PROVIDER_TYPES,
};

/** A validated provider entry with its resolved recipient target key. */
export interface ResolvedProviderEntry {
  readonly type: string;
  readonly target: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * The notifykit notifier for any provider, erased to the uniform view the
 * framework sends through (same treatment as storage's `KitStorage`).
 */
export type KitNotifier = Notifier<string, unknown, unknown, unknown, unknown>;

const providerEntrySchema = z.object({
  type: z.string().trim().min(1, 'Provider type is required'),
  target: z.string().trim().min(1, 'Provider target cannot be empty').optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const providersConfigSchema = z.object({
  push: providerEntrySchema.optional(),
  messaging: providerEntrySchema.optional(),
});

/**
 * Validates the `notifications.providers` section (zod: per-channel provider
 * `type` + options passthrough, only for channels the app declares). Only the
 * section's shape is checked here — an unavailable provider is not a config
 * error; it surfaces as `NOTIFICATION_PROVIDER_UNAVAILABLE` when the notifier
 * is created (same rule as storage).
 */
export function parseNotificationsProviders(config: NotificationsProvidersConfig): NotificationsProvidersConfig {
  const result = providersConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) =>
          `notifications.providers${issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : ''}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

/**
 * Resolves one channel's configured provider: the type must belong to the
 * channel's family (or name a custom kit provider), and the recipient target
 * key must be known — built-in types have documented defaults; custom
 * providers must declare `target` in the config.
 */
export function resolveProviderEntry(
  channel: KitChannel,
  entry: NotificationProviderConfig,
  kitProviders: readonly KitNotificationDriver[],
): ResolvedProviderEntry {
  const family = CHANNEL_PROVIDERS[channel];
  const custom = kitProviders.some((driver) => driver.name === entry.type);
  const target = entry.target ?? KIT_DEFAULT_TARGETS[entry.type];
  if (!family.includes(entry.type) && !custom) {
    throw new NotificationProviderUnavailableError(
      `Provider "${entry.type}" is not available for the ${channel} channel; supported: ${family.join(', ')}${
        kitProviders.length > 0
          ? `, or custom kit providers: ${kitProviders.map((driver) => String(driver.name)).join(', ')}`
          : ''
      }`,
    );
  }
  if (!target) {
    throw new NotificationProviderUnavailableError(
      `Provider "${entry.type}" must declare the recipient target key its string target is delivered as (e.g. target: "token")`,
    );
  }
  return { type: entry.type, target, options: entry.options ?? {} };
}

/**
 * Creates the channel's notifier through notifykit's `createNotifier` — the
 * same factory path real applications take, so provider SDKs load lazily
 * exactly as they do in production. notifykit signals a missing peer SDK or
 * invalid provider options with its typed `NotificationConfigError`; both are
 * mapped to the catalogued `NOTIFICATION_PROVIDER_UNAVAILABLE` so application
 * code never has to depend on kit error classes.
 */
export async function createKitNotifier(
  channel: KitChannel,
  entry: ResolvedProviderEntry,
  kitProviders: readonly KitNotificationDriver[],
): Promise<KitNotifier> {
  const config = { type: entry.type, ...entry.options };
  try {
    if (kitProviders.length === 0) {
      return (await createNotifier(config as never)) as unknown as KitNotifier;
    }
    return (await createNotifier(config as never, { providers: kitProviders as never })) as unknown as KitNotifier;
  } catch (error) {
    // The root entry bundles every built-in driver, so the kit's typed
    // config error (missing peer SDK, invalid provider options) keeps its
    // class identity across this boundary.
    if (error instanceof NotificationConfigError) {
      throw new NotificationProviderUnavailableError(
        `The ${channel} provider "${entry.type}" is unavailable: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Builds the notifykit message for one kit-channel delivery. The framework
 * envelope stays provider-agnostic: the string target is wrapped into the
 * provider's recipient via the configured target key, the built content maps
 * onto notifykit's `notification`, and `native` passes through verbatim.
 * The envelope payload itself never leaves the process — only built content
 * and the explicit `native` passthrough do. `webpush`'s recipient additionally
 * requires the subscription keys; the documented convention is `native.keys`
 * (`{ p256dh, auth }`), validated by the provider on send.
 */
export function kitMessage(
  targetKey: string,
  envelope: NotificationEnvelope,
  content: { readonly title?: string; readonly body: string },
  idempotencyKey: string,
): NotificationMessage<unknown, unknown> {
  const native = envelope.native;
  const to: unknown =
    targetKey === 'endpoint'
      ? { endpoint: envelope.to, keys: native !== undefined && 'keys' in native ? native.keys : undefined }
      : { [targetKey]: envelope.to };
  return {
    to,
    notification: { ...(content.title !== undefined ? { title: content.title } : {}), body: content.body },
    ...(native !== undefined ? { native } : {}),
    idempotencyKey,
  };
}
