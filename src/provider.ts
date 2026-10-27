import { defineProvider, type ServiceProvider } from '@framework/core';
import { MAILER } from '@framework/mail';
import { QUEUE } from '@framework/queue';
import { NOTIFICATION_STORE, NOTIFICATIONS } from './constants';
import { NotificationStoreError } from './errors';
import { NotificationsService } from './service';
import type { NotificationsProviderOptions } from './types';

export { NOTIFICATION_STORE, NOTIFICATIONS };

/**
 * Registers the notifications stack as one singleton: the
 * `NotificationsService` wired to the bound `MAILER` (from the mail
 * provider), the bound queue manager (`QUEUE`, from the application's queue
 * wiring) and the application-owned notification store.
 *
 * `NOTIFICATION_STORE` must be bound by the application — the framework does
 * NOT own a notifications table — and resolution fails with
 * `NOTIFICATION_STORE_UNBOUND` when it is missing. The mailer and queue
 * manager resolve through the container, so a missing mail/queue wiring
 * surfaces as the container's own unbound-token error at first resolution.
 * Applications add this provider after the mail provider and their queue
 * wiring.
 *
 * The `push`/`messaging` channels delegate to notifykit providers declared in
 * `options.providers` (the `notifications.providers` section) and are created
 * lazily through notifykit's `createNotifier`; `options.kitProviders` passes
 * custom notifykit driver definitions through to that same construction path
 * (e.g. notifykit's testing fake). Email stays owned by `@framework/mail`.
 */
export function createNotificationsProvider<TConfig extends object = object>(
  options: NotificationsProviderOptions = {},
): ServiceProvider<TConfig> {
  return defineProvider<TConfig>({
    name: 'notifications',
    dependsOn: ['mail'],
    register({ container }) {
      container.singleton(NOTIFICATIONS, (r) => {
        if (!r.has(NOTIFICATION_STORE)) throw new NotificationStoreError();
        return new NotificationsService({
          mailer: r.resolve(MAILER),
          queue: r.resolve(QUEUE),
          store: r.resolve(NOTIFICATION_STORE),
          ...(options.definitions ? { definitions: options.definitions } : {}),
          ...(options.job ? { job: options.job } : {}),
          ...(options.providers ? { providers: options.providers } : {}),
          ...(options.kitProviders ? { kitProviders: options.kitProviders } : {}),
        });
      });
    },
  });
}
