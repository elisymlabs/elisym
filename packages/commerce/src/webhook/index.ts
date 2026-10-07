/**
 * `@elisym/commerce/webhook`: the merchant side of the node's signed webhook.
 * `verifyWebhook` authenticates and parses a request; `signWebhook` is what the
 * node signs with. Both run on WebCrypto only and import nothing Node-only or
 * from the rest of the protocol, so a backend that only verifies webhooks loads
 * just this.
 */
export {
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_MIN_SECRET_BYTES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECS,
} from './constants';
export type {
  OrderPaidWebhookEvent,
  TestWebhookEvent,
  WebhookEvent,
  WebhookPayment,
} from './event';
export { type SignWebhookInput, signWebhook } from './sign';
export {
  type VerifyWebhookInput,
  type VerifyWebhookResult,
  type WebhookFailureReason,
  type WebhookHeaderGetter,
  type WebhookHeaders,
  verifyWebhook,
} from './verify';
