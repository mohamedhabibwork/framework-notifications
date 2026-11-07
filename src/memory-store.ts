import type {
  ChannelStatus,
  DatabaseChannelStore,
  DeliveryState,
  DeliveryStatus,
  NotificationChannel,
  NotificationRecordInput,
} from './types';

interface StoredRecord {
  readonly id: string;
  readonly record: NotificationRecordInput;
  readonly createdAt: string;
  readonly channels: Map<NotificationChannel, ChannelStatus>;
}

/**
 * The documented test/fake store (the notifications counterpart of mail's
 * `MemoryMailTransport`): keeps every record and per-channel status in memory
 * so tests assert on exactly what the service recorded. A fake records
 * intended delivery only — it is not evidence of real database behavior
 * (spec §9); applications implement `DatabaseChannelStore` on their own
 * schema for real persistence.
 */
export class InMemoryNotificationStore implements DatabaseChannelStore {
  readonly #records = new Map<string, StoredRecord>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** Every stored record (input verbatim), oldest first — test assertions on what the service persisted. */
  records(): readonly NotificationRecordInput[] {
    return [...this.#records.values()].map((stored) => stored.record);
  }

  async store(record: NotificationRecordInput): Promise<{ id: string }> {
    const id = this.newId();
    const now = new Date().toISOString();
    this.#records.set(id, {
      id,
      record,
      createdAt: now,
      channels: new Map(
        record.channels.map((channel) => [channel, { channel, state: 'pending', updatedAt: now } as ChannelStatus]),
      ),
    });
    return { id };
  }

  async markDelivered(id: string, channel: NotificationChannel, reference?: string): Promise<void> {
    this.#transition(id, channel, { state: 'delivered', ...(reference !== undefined ? { reference } : {}) });
  }

  async markFailed(id: string, channel: NotificationChannel, message: string): Promise<void> {
    this.#transition(id, channel, { state: 'failed', error: message });
  }

  async status(id: string): Promise<DeliveryStatus | null> {
    const stored = this.#records.get(id);
    if (!stored) return null;
    return {
      id: stored.id,
      name: stored.record.name,
      recipient: stored.record.recipient,
      createdAt: stored.createdAt,
      channels: stored.record.channels.map(
        (channel) => stored.channels.get(channel) ?? { channel, state: 'pending', updatedAt: stored.createdAt },
      ),
    };
  }

  #transition(
    id: string,
    channel: NotificationChannel,
    patch: { state: DeliveryState; reference?: string; error?: string },
  ): void {
    const stored = this.#records.get(id);
    if (!stored) throw new Error(`Unknown notification record "${id}"`);
    stored.channels.set(channel, {
      channel,
      state: patch.state,
      ...(patch.reference !== undefined ? { reference: patch.reference } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
}
