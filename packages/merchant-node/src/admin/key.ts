import * as nip19 from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

const HEX_SECRET_RE = /^[0-9a-fA-F]{64}$/;

/** The store's secret key, held in this page's memory only, and its pubkey. */
export interface StoreKey {
  secretKey: Uint8Array;
  pubkey: string;
}

function decodeSecret(value: string): Uint8Array | undefined {
  if (HEX_SECRET_RE.test(value)) {
    return hexToBytes(value.toLowerCase());
  }
  if (!value.startsWith('nsec1')) {
    return undefined;
  }
  const decoded = nip19.decode(value);
  return decoded.type === 'nsec' ? decoded.data : undefined;
}

/** The store key from what was pasted (an nsec or 64 hex), or `undefined` for anything else. */
export function parseStoreKey(text: string): StoreKey | undefined {
  try {
    const secretKey = decodeSecret(text.trim());
    return secretKey === undefined ? undefined : { secretKey, pubkey: getPublicKey(secretKey) };
  } catch {
    return undefined;
  }
}
