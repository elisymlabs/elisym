import { isPublicHostname } from '@elisym/commerce';

/** The longest relay URL the checkout accepts (its `MAX_RELAY_URL_LENGTH`). */
const MAX_RELAY_URL_LENGTH = 256;

/**
 * A relay URL in the one spelling the checkout uses, or `undefined` for one it
 * never contacts: only `wss:` on a public DNS name, no credentials, query or
 * fragment, repeated slashes collapsed and a trailing one dropped (the
 * checkout's `normalizeRelayUrl`).
 */
export function checkoutRelaySpelling(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_RELAY_URL_LENGTH || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  if (
    url.protocol !== 'wss:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isPublicHostname(url.hostname)
  ) {
    return undefined;
  }
  return `wss://${url.host}${url.pathname.replace(/\/+/g, '/').replace(/\/$/, '')}`;
}
