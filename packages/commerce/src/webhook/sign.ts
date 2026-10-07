import { hmacSha256, secretBytes, signedBytes, toHex } from './crypto';

export interface SignWebhookInput {
  /** The shared secret, UTF-8, at least `WEBHOOK_MIN_SECRET_BYTES` bytes. */
  secret: string;
  /** Unix seconds of this attempt: a non-negative safe integer. */
  timestamp: number;
  /** The exact body that is sent. */
  body: string;
}

/**
 * The `X-Elisym-Signature` header value:
 * `v1=<lowercase hex HMAC-SHA256(secret, `${timestamp}.${body}`)>`.
 */
export async function signWebhook(input: SignWebhookInput): Promise<string> {
  const key = secretBytes(input.secret, 'signWebhook');
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new TypeError('signWebhook: timestamp must be a non-negative safe integer');
  }
  if (typeof input.body !== 'string') {
    throw new TypeError('signWebhook: body must be a string');
  }
  const mac = await hmacSha256(key, signedBytes(String(input.timestamp), input.body));
  return `v1=${toHex(mac)}`;
}
