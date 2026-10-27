import { currentExecution } from '@framework/core';
import type { Mailer } from '@framework/mail';
import type { DispatchOptions, JobDefinition, QueueManager } from '@framework/queue';
import { defineNotification } from './definition';
import {
  databaseContentSchema,
  emailContentSchema,
  messagingContentSchema,
  parseNotificationEnvelope,
  pushContentSchema,
  toNotificationFieldErrors,
} from './envelope';
import {
  NotificationChannelError,
  NotificationDefinitionError,
  NotificationDeliveryError,
  NotificationProviderUnavailableError,
  NotificationUnknownError,
  NotificationValidationError,
} from './errors';
import { defineNotificationJob } from './job';
import {
  createKitNotifier,
  type KitNotifier,
  kitMessage,
  parseNotificationsProviders,
  type ResolvedProviderEntry,
  resolveProviderEntry,
} from './kit';
import type {
  AnyNotificationDefinition,
  DatabaseChannelStore,
  DatabaseContent,
  DeliveryStatus,
  EmailContent,
  KitChannel,
  KitNotificationDriver,
  MessagingContent,
  NotificationChannel,
  NotificationEnvelope,
  NotificationJobPayload,
  NotificationJobResult,
  NotificationRecordInput,
  NotificationsServiceOptions,
  PushContent,
  SendQueuedOptions,
} from './types';

/** Everything needed to deliver one validated notification: the envelope plus built content per selected channel. */
interface DeliveryPlan {
  readonly envelope: NotificationEnvelope;
  readonly email?: EmailContent;
  readonly database?: DatabaseContent;
  readonly push?: PushContent;
  readonly messaging?: MessagingContent;
}

/**
 * The message recorded for a failed channel: the root cause's message, not
 * the wrappers added on the way out (e.g. the `Mailer`'s
 * `MAIL_TRANSPORT_FAILED` wrapper), so the stored status shows what actually
 * went wrong.
 */
function failureMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

/**
 * The error for kit channels the application did not configure a provider for
 * (`notifications.providers`): fail fast, before anything is persisted.
 */
function unavailableChannelError(channels: readonly KitChannel[]): NotificationProviderUnavailableError {
  return new NotificationProviderUnavailableError(
    `No notifykit provider is configured for channel(s) ${channels.join(', ')} — declare them under notifications.providers`,
  );
}

/**
 * The notifications service (spec §8): validates a notification envelope,
 * persists one record through the application-owned store (pending per
 * selected channel), then fans out per channel — the `email` channel via the
 * bound `Mailer`, the `database` channel via the store itself, and the
 * `push`/`messaging` channels via notifykit providers configured under
 * `notifications.providers` (created lazily through notifykit's
 * `createNotifier`; provider SDKs are optional peers loaded on that path).
 * A failure in one channel is recorded and never blocks the others; only a
 * store outage or an unavailable kit provider propagates. `sendQueued` defers
 * the fan-out to `@framework/queue`: retries and duplicate-delivery semantics
 * ride the queue's retry policy, the service only records outcomes.
 */
export class NotificationsService {
  readonly #mailer: Mailer;
  readonly #store: DatabaseChannelStore;
  readonly #queue: QueueManager;
  readonly #job: JobDefinition<NotificationJobPayload, NotificationJobResult>;
  readonly #definitions = new Map<string, AnyNotificationDefinition>();
  readonly #kitProviders: readonly KitNotificationDriver[];
  readonly #kitEntries: Partial<Record<KitChannel, ResolvedProviderEntry>>;
  readonly #kitNotifiers = new Map<KitChannel, Promise<KitNotifier>>();

  constructor(options: NotificationsServiceOptions) {
    this.#mailer = options.mailer;
    this.#store = options.store;
    this.#queue = options.queue;
    this.#job = options.job ?? defineNotificationJob();
    this.#kitProviders = options.kitProviders ?? [];
    const providers = parseNotificationsProviders(options.providers ?? {});
    this.#kitEntries = {
      ...(providers.push ? { push: resolveProviderEntry('push', providers.push, this.#kitProviders) } : {}),
      ...(providers.messaging
        ? { messaging: resolveProviderEntry('messaging', providers.messaging, this.#kitProviders) }
        : {}),
    };
    for (const candidate of options.definitions ?? []) {
      const definition = defineNotification(candidate);
      if (this.#definitions.has(definition.name)) {
        throw new NotificationDefinitionError(`Notification "${definition.name}" is registered twice`);
      }
      this.#definitions.set(definition.name, definition);
    }
  }

  /** Delivers inline: validates, persists the record (pending), fans out, returns the final per-channel status. */
  async send(input: NotificationEnvelope): Promise<DeliveryStatus> {
    const plan = this.#plan(input);
    const { id } = await this.#store.store(this.#record(plan));
    await Promise.all(plan.envelope.channels.map((channel) => this.#attemptChannel(id, channel, plan)));
    return this.#requireStatus(id);
  }

  /**
   * Queued delivery: validates, persists the record (pending) and dispatches
   * the versioned delivery job. The worker fans out on the queue's retry
   * policy; the idempotency key (`notification-<recordId>`) collapses
   * duplicate dispatches of the same record.
   */
  async sendQueued(
    input: NotificationEnvelope,
    options: SendQueuedOptions = {},
  ): Promise<{ id: string; jobId: string }> {
    const plan = this.#plan(input);
    const { id } = await this.#store.store(this.#record(plan));
    const payload: NotificationJobPayload = {
      recordId: id,
      envelope: plan.envelope,
      ...(plan.email ? { email: plan.email } : {}),
      ...(plan.database ? { database: plan.database } : {}),
      ...(plan.push ? { push: plan.push } : {}),
      ...(plan.messaging ? { messaging: plan.messaging } : {}),
    };
    const dispatch: DispatchOptions = {
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    };
    const { id: jobId } = await this.#queue.dispatch(
      this.#job,
      payload,
      options.execution ?? currentExecution(),
      dispatch,
    );
    return { id, jobId };
  }

  /**
   * Body of the built-in delivery job. Channels already `delivered` are never
   * attempted again (idempotent resume across queue retries); any channel
   * failure is recorded, then `NOTIFICATION_DELIVERY_FAILED` is thrown so the
   * queue retries the remaining channels per its policy.
   */
  async deliverQueued(payload: NotificationJobPayload): Promise<NotificationJobResult> {
    const known = await this.#store.status(payload.recordId);
    if (!known) throw new NotificationUnknownError(payload.recordId);
    const plan: DeliveryPlan = {
      envelope: payload.envelope,
      ...(payload.email ? { email: payload.email } : {}),
      ...(payload.database ? { database: payload.database } : {}),
      ...(payload.push ? { push: payload.push } : {}),
      ...(payload.messaging ? { messaging: payload.messaging } : {}),
    };
    const pending = payload.envelope.channels.filter(
      (channel) => known.channels.find((entry) => entry.channel === channel)?.state !== 'delivered',
    );
    const attempts = await Promise.all(
      pending.map(async (channel) => ({
        channel,
        attempt: await this.#attemptChannel(payload.recordId, channel, plan),
      })),
    );
    const failures: { channel: NotificationChannel; message: string }[] = [];
    for (const { channel, attempt } of attempts) {
      if (!attempt.ok) failures.push({ channel, message: attempt.message });
    }
    const status = await this.#requireStatus(payload.recordId);
    if (failures.length > 0) throw new NotificationDeliveryError(payload.recordId, failures);
    return {
      recordId: payload.recordId,
      channels: status.channels.map(({ channel, state }) => ({ channel, state })),
    };
  }

  /** The delivery status of one notification, via the store; null when unknown. */
  status(id: string): Promise<DeliveryStatus | null> {
    return this.#store.status(id);
  }

  /** Validates the envelope, resolves the definition and builds content for every selected channel. */
  #plan(input: NotificationEnvelope): DeliveryPlan {
    const envelope = parseNotificationEnvelope(input);
    const definition = this.#definitions.get(envelope.name);
    if (!definition) throw new NotificationUnknownError(envelope.name);
    const unsupported = envelope.channels.filter((channel) => !definition.channels.includes(channel));
    if (unsupported.length > 0) {
      throw new NotificationChannelError(
        `Notification "${envelope.name}" did not declare channel(s) ${unsupported.join(', ')}; declared: ${definition.channels.join(', ') || 'none'}`,
      );
    }
    const parsed = definition.payload.safeParse(envelope.payload);
    if (!parsed.success) throw new NotificationValidationError(toNotificationFieldErrors(parsed.error));
    let email: EmailContent | undefined;
    let database: DatabaseContent | undefined;
    let push: PushContent | undefined;
    let messaging: MessagingContent | undefined;
    for (const channel of envelope.channels) {
      if (channel === 'email') email = this.#buildEmail(definition, parsed.data);
      else if (channel === 'database') database = this.#buildDatabase(definition, parsed.data);
      else if (channel === 'push') push = this.#buildKitContent(definition, 'push', parsed.data);
      else messaging = this.#buildKitContent(definition, 'messaging', parsed.data);
    }
    // Fail fast on unconfigured kit channels: nothing is persisted and no
    // channel is attempted when a declared channel has no provider.
    const unconfigured = envelope.channels
      .filter((channel): channel is KitChannel => channel === 'push' || channel === 'messaging')
      .filter((channel) => !this.#kitEntries[channel]);
    if (unconfigured.length > 0) {
      throw unavailableChannelError(unconfigured);
    }
    return {
      envelope,
      ...(email ? { email } : {}),
      ...(database ? { database } : {}),
      ...(push ? { push } : {}),
      ...(messaging ? { messaging } : {}),
    };
  }

  #buildEmail(definition: AnyNotificationDefinition, payload: object): EmailContent {
    const built = definition.toEmail?.(payload);
    if (!built) {
      throw new NotificationDefinitionError(`Notification "${definition.name}" provides no toEmail builder`);
    }
    const result = emailContentSchema.safeParse(built);
    if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
    return result.data;
  }

  #buildDatabase(definition: AnyNotificationDefinition, payload: object): DatabaseContent {
    const built = definition.toDatabase?.(payload);
    if (!built) {
      throw new NotificationDefinitionError(`Notification "${definition.name}" provides no toDatabase builder`);
    }
    const result = databaseContentSchema.safeParse(built);
    if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
    return result.data;
  }

  /** Builds (and validates) push or messaging content — one builder per kit channel, same rule as email/database. */
  #buildKitContent(
    definition: AnyNotificationDefinition,
    channel: KitChannel,
    payload: object,
  ): PushContent | MessagingContent {
    const builder = channel === 'push' ? definition.toPush : definition.toMessaging;
    const built = builder?.(payload);
    if (!built) {
      throw new NotificationDefinitionError(
        `Notification "${definition.name}" provides no ${channel === 'push' ? 'toPush' : 'toMessaging'} builder`,
      );
    }
    const schema = channel === 'push' ? pushContentSchema : messagingContentSchema;
    const result = schema.safeParse(built);
    if (!result.success) throw new NotificationValidationError(toNotificationFieldErrors(result.error));
    return result.data;
  }

  #record(plan: DeliveryPlan): NotificationRecordInput {
    return {
      name: plan.envelope.name,
      recipient: plan.envelope.to,
      channels: plan.envelope.channels,
      payload: plan.envelope.payload,
      ...(plan.email ? { email: plan.email } : {}),
      ...(plan.database ? { database: plan.database } : {}),
      ...(plan.push ? { push: plan.push } : {}),
      ...(plan.messaging ? { messaging: plan.messaging } : {}),
    };
  }

  /**
   * The channel's notifykit notifier, created through `createNotifier` on
   * first use (provider SDKs load lazily there) and cached per channel. A
   * failed creation is not cached: the next attempt constructs again, so a
   * fixed environment recovers without a restart.
   */
  #kitNotifier(channel: KitChannel): Promise<KitNotifier> {
    let notifier = this.#kitNotifiers.get(channel);
    if (!notifier) {
      const entry = this.#kitEntries[channel];
      if (!entry) {
        return Promise.reject(unavailableChannelError([channel]));
      }
      notifier = createKitNotifier(channel, entry, this.#kitProviders);
      notifier.catch(() => {
        const cached = this.#kitNotifiers.get(channel);
        if (cached === notifier) this.#kitNotifiers.delete(channel);
      });
      this.#kitNotifiers.set(channel, notifier);
    }
    return notifier;
  }

  /**
   * One channel attempt. Channel failures are recorded through the store and
   * returned, never thrown — one channel must not block the others. Only a
   * store outage (status cannot be recorded) or an unavailable kit provider
   * (a configuration gap, mirroring storage's `STORAGE_DRIVER_UNAVAILABLE`)
   * propagates.
   */
  async #attemptChannel(
    id: string,
    channel: NotificationChannel,
    plan: DeliveryPlan,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (channel === 'push' || channel === 'messaging') {
      // Created before the try: a provider the kit cannot construct is an
      // infrastructure/configuration failure, not a delivery outcome.
      const notifier = await this.#kitNotifier(channel);
      const content = channel === 'push' ? plan.push : plan.messaging;
      if (!content) {
        throw new NotificationDefinitionError(`Notification "${plan.envelope.name}" has no built ${channel} content`);
      }
      const entry = this.#kitEntries[channel];
      if (!entry) throw unavailableChannelError([channel]);
      try {
        const message = kitMessage(entry.target, plan.envelope, content, `notification-${id}-${channel}`);
        const result = await notifier.send(message);
        if (!result.ok) {
          throw new Error(
            `The ${channel} provider "${result.provider}" did not accept the notification (status: ${result.status})`,
          );
        }
        await this.#store.markDelivered(id, channel, result.messageId);
        return { ok: true };
      } catch (cause) {
        const message = failureMessage(cause);
        await this.#store.markFailed(id, channel, message);
        return { ok: false, message };
      }
    }
    try {
      if (channel === 'email') {
        const content = plan.email;
        if (!content) {
          throw new NotificationDefinitionError(`Notification "${plan.envelope.name}" has no built email content`);
        }
        const composer = this.#mailer.to(plan.envelope.to).subject(content.subject);
        let body = composer;
        if (content.text !== undefined) body = body.text(content.text);
        if (content.html !== undefined) body = body.html(content.html);
        const sent = await body.send();
        await this.#store.markDelivered(id, 'email', sent[0]?.id);
      } else {
        // The database row was persisted by the store at record creation; the
        // channel is delivered as soon as that row exists and is marked here.
        await this.#store.markDelivered(id, 'database');
      }
      return { ok: true };
    } catch (cause) {
      const message = failureMessage(cause);
      await this.#store.markFailed(id, channel, message);
      return { ok: false, message };
    }
  }

  async #requireStatus(id: string): Promise<DeliveryStatus> {
    const status = await this.#store.status(id);
    if (!status) throw new NotificationUnknownError(id);
    return status;
  }
}
