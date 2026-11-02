// Public API of @framework/notifications.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (classes, functions, schemas) stay in their modules.
export {
  BUILT_IN_NOTIFICATION_CHANNELS,
  KIT_DEFAULT_TARGETS,
  MESSAGING_PROVIDER_TYPES,
  NOTIFICATION_STORE,
  NOTIFICATIONS,
  PUSH_PROVIDER_TYPES,
  SMS_PLANNED,
} from './constants';
export { defineChannel, defineNotification } from './definition';
export {
  databaseContentSchema,
  emailContentSchema,
  messagingContentSchema,
  notificationEnvelopeSchema,
  notificationEnvelopeSchemaFor,
  parseDatabaseContent,
  parseEmailContent,
  parseMessagingContent,
  parseNotificationEnvelope,
  parsePushContent,
  pushContentSchema,
  toNotificationFieldErrors,
} from './envelope';
export {
  NotificationChannelError,
  NotificationDefinitionError,
  NotificationDeliveryError,
  NotificationProviderUnavailableError,
  NotificationStoreError,
  NotificationUnknownError,
  NotificationValidationError,
} from './errors';
export {
  defineNotificationJob,
  NOTIFICATION_JOB_NAME,
  NOTIFICATION_JOB_VERSION,
  notificationJobPayloadSchema,
} from './job';
export type { KitNotifier, ResolvedProviderEntry } from './kit';
export {
  createKitNotifier,
  kitMessage,
  notificationProviderEntrySchema,
  notificationsConfigSchema,
  notificationsProvidersSchema,
  parseNotificationsProviders,
  resolveProviderEntry,
} from './kit';
export { InMemoryNotificationStore } from './memory-store';
export { createNotificationsProvider } from './provider';
export { NotificationsService } from './service';
// Grouped conventions: every type in ./types, every constant in ./constants.
// (`NotificationsService` is a class value exported from ./service above; its
// type is re-exported there, so it is not repeated in this group.)
export type {
  AnyNotificationChannelDefinition,
  AnyNotificationDefinition,
  BuiltInNotificationChannel,
  ChannelDelivery,
  ChannelStatus,
  DatabaseChannelStore,
  DatabaseContent,
  DeliveryState,
  DeliveryStatus,
  EmailContent,
  KitChannel,
  KitNotificationDriver,
  MessagingContent,
  NotificationChannel,
  NotificationChannelDefinition,
  NotificationDefinition,
  NotificationEnvelope,
  NotificationFieldError,
  NotificationInput,
  NotificationJobOptions,
  NotificationJobPayload,
  NotificationJobResult,
  NotificationName,
  NotificationPayload,
  NotificationProviderConfig,
  NotificationRecordInput,
  NotificationsProviderOptions,
  NotificationsProvidersConfig,
  NotificationsServiceOptions,
  PushContent,
  SendQueuedOptions,
} from './types';
