import { ASKR_API_BASE as PUBLIC_API_BASE, ASKR_RELAYS } from '@elisym/askr';

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function configured(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === '' ? fallback : withoutTrailingSlash(value.trim());
}

/**
 * The API every admin call goes to: the page's own origin, since the Askr
 * server serves the admin itself (7.3), unless `VITE_ASKR_API_BASE` overrides
 * it for development. NIP-98 `u` is this base plus the path, so it must equal
 * the server's configured public base.
 */
export function apiBase(
  override: string | undefined = import.meta.env.VITE_ASKR_API_BASE,
  origin: string | undefined = globalThis.location?.origin,
): string {
  return configured(override, origin ?? PUBLIC_API_BASE);
}

/** The relay configs, authorizations, listings and policies are read from. */
export const RELAY_URL = configured(import.meta.env.VITE_ASKR_RELAY, ASKR_RELAYS[0] ?? '');

/** The public host the embed snippet loads the widget from. */
export const WIDGET_SCRIPT_URL = `${PUBLIC_API_BASE}/widget.js`;

/** The widget's custom element (`packages/askr-widget/src/constants.ts`). */
export const WIDGET_ELEMENT = 'askr-chat';

/** The CLI command that prints a merchant catalog key K for this store. */
export const ASKR_KEY_COMMAND = 'elisym askr-key <agent> --store';

/** How often the dashboard re-reads the store while a catalog sync runs. */
export const SYNC_POLL_MS = 3_000;
/**
 * The same with a browser extension, which may ask the merchant to approve
 * every NIP-98 signature: rarely, with the Refresh button for the impatient.
 */
export const EXTENSION_SYNC_POLL_MS = 30_000;

/** How far ahead of the local clock a relay event may be dated and still count. */
export const MAX_FUTURE_SKEW_SECS = 10 * 60;

/** Languages offered first in the onboarding form; any BCP 47 tag is accepted. */
export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_CURRENCY = 'USD';
