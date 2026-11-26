/**
 * What the Embed tab shows (A9): the v3 `<elisym-buy>` snippet for a product,
 * as `merchant-landing`'s snippet and the widget docs build it, and the
 * `nostr.json` a level A domain serves (as merchant-node's `storeNostrJson`).
 * Nothing here is checked against the domain: the page only shows what to serve.
 */
import { encodeProductNaddr, splitNip05 } from '@elisym/commerce';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from './embed-constants';
import type { StoreConfig } from './types';

/** The relay hints a product `naddr` carries, as merchant-node prints them. */
const NADDR_HINTS = 2;

/** The nostr.json name commerce reads the owner key from: a store cannot take it. */
export const OWNER_NAME = 'owner';

/** The domain-wide name: the only one that gives level A. */
export const DOMAIN_WIDE_NAME = '_';

const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/** A value safe inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (char) => ATTRIBUTE_ESCAPES[char] ?? char);
}

/** Product `d` of store `storePubkey`, with the store's inbox relays as hints. */
export function productNaddr(storePubkey: string, d: string, config: StoreConfig): string {
  const relays =
    config.activeInboxRelays.length > 0 ? config.activeInboxRelays : config.inboxRelays;
  return encodeProductNaddr({ storePubkey, d }, relays.slice(0, NADDR_HINTS));
}

/** The snippet a merchant pastes: the element, then the pinned v3 loader with its SRI hash. */
export function embedSnippet(naddr: string, network: string): string {
  return [
    `<elisym-buy product="${escapeAttribute(naddr)}" network="${escapeAttribute(network)}"></elisym-buy>`,
    '<script',
    `  src="${escapeAttribute(V3_LOADER_SRC)}"`,
    `  integrity="${escapeAttribute(V3_LOADER_INTEGRITY)}"`,
    '  crossorigin="anonymous"',
    '></script>',
  ].join('\n');
}

export type DomainGuide =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'owner_name'; domain: string }
  | {
      kind: 'nostr_json';
      domain: string;
      local: string;
      /** Whether this name can give level A (only `_`, the domain-wide name). */
      levelA: boolean;
      url: string;
      json: string;
    };

/** What the store's domain must serve for level A: S under the nip05 name, O under `owner`. */
export function domainGuide(
  nip05: string | undefined,
  storePubkey: string,
  ownerPubkey: string,
): DomainGuide {
  if (nip05 === undefined || nip05.trim() === '') {
    return { kind: 'none' };
  }
  const split = splitNip05(nip05);
  if (split === undefined) {
    return { kind: 'invalid' };
  }
  if (split.local === OWNER_NAME) {
    return { kind: 'owner_name', domain: split.domain };
  }
  const names: Record<string, string> = { [split.local]: storePubkey, [OWNER_NAME]: ownerPubkey };
  return {
    kind: 'nostr_json',
    domain: split.domain,
    local: split.local,
    levelA: split.local === DOMAIN_WIDE_NAME,
    url: `https://${split.domain}/.well-known/nostr.json`,
    json: JSON.stringify({ names }, null, 2),
  };
}
