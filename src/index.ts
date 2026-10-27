// Public API of @framework/notifications.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (classes, functions, schemas) stay in their modules.
export {
  KIT_DEFAULT_TARGETS,
  MESSAGING_PROVIDER_TYPES,
  NOTIFICATION_STORE,
  NOTIFICATIONS,
  PUSH_PROVIDER_TYPES,
  SMS_PLANNED,
} from './constants';
export { defineNotification } from './definition';
export {
  databaseContentSchema,
  emailContentSchema,
  messagingContentSchema,
  notificationEnvelopeSchema,
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
export type { KitNotifier } from './kit';
export { createKitNotifier, kitMessage, parseNotificationsProviders, resolveProviderEntry } from './kit';
export { InMemoryNotificationStore } from './memory-store';
export { createNotificationsProvider } from './provider';
export { NotificationsService } from './service';
// Grouped conventions: every type in ./types, every constant in ./constants.
// (`NotificationsService` is a class value exported from ./service above; its
// type is re-exported there, so it is not repeated in this group.)
export type {
  AnyNotificationDefinition,
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
  NotificationDefinition,
  NotificationEnvelope,
  NotificationFieldError,
  NotificationJobOptions,
  NotificationJobPayload,
  NotificationJobResult,
  NotificationProviderConfig,
  NotificationRecordInput,
  NotificationsProviderOptions,
  NotificationsProvidersConfig,
  NotificationsServiceOptions,
  PushContent,
  SendQueuedOptions,
} from './types';
