import { z } from 'zod/v4';
import { defineChannel } from './definition';
import type { NotificationChannelDefinition, SmsMessage, SmsTransport } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SMS_LENGTH = 1_600;
const E164 = /^\+[1-9]\d{6,14}$/;

interface SmsProviderOptions {
  /** Sender: a phone number, or an alphanumeric id where the provider allows one. */
  readonly from: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface TwilioSmsOptions extends SmsProviderOptions {
  readonly accountSid: string;
  readonly authToken: string;
}

export interface VonageSmsOptions extends SmsProviderOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/** Posts a form and reads JSON, leaving an empty object for a body that isn't. */
async function postForm(
  options: SmsProviderOptions,
  url: string,
  form: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly ok: boolean; readonly body: Readonly<Record<string, unknown>> }> {
  const send = options.fetch ?? fetch;
  const response = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ ...form }).toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ok: response.ok,
    body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
  };
}

/** Sends through Twilio's Messages API. */
export function twilioSms(options: TwilioSmsOptions): SmsTransport {
  const base = options.baseUrl ?? 'https://api.twilio.com';
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const authorization = `Basic ${btoa(`${options.accountSid}:${options.authToken}`)}`;
  return {
    async send(message) {
      const { ok, status, body } = await postForm(
        options,
        url,
        { To: message.to, From: options.from, Body: message.body },
        { authorization },
      );
      if (!ok || typeof body.sid !== 'string') {
        const reason = typeof body.message === 'string' ? body.message : `status ${status}`;
        throw new Error(`Twilio did not accept the message: ${reason}`);
      }
      return { id: body.sid };
    },
  };
}

interface VonageResult {
  readonly status?: unknown;
  readonly 'message-id'?: unknown;
  readonly 'error-text'?: unknown;
}

/** Sends through Vonage's SMS API, which reports most failures in a 200 response. */
export function vonageSms(options: VonageSmsOptions): SmsTransport {
  const url = `${options.baseUrl ?? 'https://rest.nexmo.com'}/sms/json`;
  return {
    async send(message) {
      const { status, body } = await postForm(options, url, {
        api_key: options.apiKey,
        api_secret: options.apiSecret,
        to: message.to.replace(/^\+/, ''),
        from: options.from,
        text: message.body,
      });
      const [result] = (Array.isArray(body.messages) ? body.messages : []) as readonly VonageResult[];
      if (result?.status !== '0' || typeof result['message-id'] !== 'string') {
        const reason = typeof result?.['error-text'] === 'string' ? result['error-text'] : `status ${status}`;
        throw new Error(`Vonage did not accept the message: ${reason}`);
      }
      return { id: result['message-id'] };
    },
  };
}

/** Records messages instead of sending them, for tests and development. */
export class MemorySmsTransport implements SmsTransport {
  readonly #sent: SmsMessage[] = [];

  get sent(): readonly SmsMessage[] {
    return [...this.#sent];
  }

  async send(message: SmsMessage): Promise<{ readonly id: string }> {
    this.#sent.push(message);
    return { id: `memory-${this.#sent.length}` };
  }
}

/**
 * The `sms` notification channel. Pass it to the notifications provider as
 * `channels`, and give each notification a builder under `content.sms`. Recipients
 * must be E.164 numbers; another format is recorded as a failed delivery.
 */
export const smsChannel = (transport: SmsTransport): NotificationChannelDefinition<'sms', { readonly body: string }> =>
  defineChannel({
    name: 'sms',
    content: z.object({ body: z.string().trim().min(1).max(MAX_SMS_LENGTH) }),
    async deliver(to, content) {
      if (!E164.test(to)) throw new Error('The sms channel requires an E.164 recipient, such as +15550100');
      const { id } = await transport.send({ to, body: content.body });
      return { reference: id };
    },
  });
