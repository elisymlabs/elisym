/**
 * The webhook URL as the server takes it for a hosted store
 * (`paycore-server` `hostedWebhookProblem`: merchant-node `webhookUrlProblem`
 * without `allowInsecure`, then the fetch guard's `checkUrl`, within the
 * config schema's 2048 characters): https on the default port, no user name
 * or password, a public DNS name (never an IP literal).
 */
import { isPublicHostname } from '@elisym/commerce';

/** The config schema's bound on `webhookUrl`. */
export const MAX_WEBHOOK_URL = 2048;

export const WEBHOOK_NOT_USABLE =
  'Enter the webhook address as a full https:// URL on a public domain name (no IP address, port, user name or password), or leave it empty for no webhook.';

/** The typed webhook address: null for none, undefined when the server would refuse it. */
export function webhookUrlInput(typed: string): string | null | undefined {
  const text = typed.trim();
  if (text === '') {
    return null;
  }
  if (text.length > MAX_WEBHOOK_URL || !URL.canParse(text)) {
    return undefined;
  }
  const url = new URL(text);
  const usable =
    url.protocol === 'https:' &&
    (url.port === '' || url.port === '443') &&
    url.username === '' &&
    url.password === '' &&
    isPublicHostname(url.hostname);
  return usable ? text : undefined;
}
