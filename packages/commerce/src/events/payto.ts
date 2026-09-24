import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { canonicalPayoutAddress, hasValidEvmChecksum, parseCaip19, type Caip19 } from '../caip';
import { KIND_PAYTO } from '../constants';
import { HEX_PUBKEY_RE, nowSecs, tagsNamed } from '../tags';
import { verifyPaytoProof } from '../wallet-proof';

/** One payout address for one asset, as the owner published it. */
export interface PayoutTarget {
  caip19: Caip19;
  /** Canonical spelling (lowercase on EVM). */
  address: string;
  /** The wallet signed the proof message for this owner and asset, and it checks out. */
  walletSigned: boolean;
}

export interface PaytoInput {
  /** NIP-A3 `payto` entries, e.g. `{ type: 'solana', authority: '<address>' }`. */
  payto?: readonly { type: string; authority: string }[];
  accept: readonly { caip19: string; address: string; signature?: string }[];
  /**
   * The owner key that will sign the event. Required with any wallet signature:
   * a proof made for another owner or asset is checked here, since every reader
   * would drop that address.
   */
  ownerPubkey?: string;
  createdAt?: number;
}

/** Build the owner's kind 10133 event. The caller signs it with the OWNER key. */
export function buildPaytoEvent(input: PaytoInput): EventTemplate {
  const tags: string[][] = [];
  for (const entry of input.payto ?? []) {
    tags.push(['payto', entry.type, entry.authority]);
  }
  for (const entry of input.accept) {
    const caip19 = parseCaip19(entry.caip19);
    if (!caip19) {
      throw new Error(`Not a payable CAIP-19 asset: ${entry.caip19}`);
    }
    const address = canonicalPayoutAddress(caip19.chain, entry.address);
    if (!address) {
      throw new Error(`Not a ${caip19.chain.family} address: ${entry.address}`);
    }
    // The wire form is lowercase, so the checksum is checked here or never.
    if (caip19.chain.family === 'evm' && !hasValidEvmChecksum(entry.address)) {
      throw new Error(`EIP-55 checksum mismatch, likely a typo: ${entry.address}`);
    }
    if (entry.signature !== undefined) {
      if (input.ownerPubkey === undefined || !HEX_PUBKEY_RE.test(input.ownerPubkey)) {
        throw new Error('A wallet signature needs ownerPubkey as 64 lowercase hex characters');
      }
      const proven = verifyPaytoProof({
        chain: caip19.chain,
        address,
        ownerPubkey: input.ownerPubkey,
        caip19: caip19.id,
        signature: entry.signature,
      });
      if (!proven) {
        throw new Error(`The wallet signature does not prove ${address} for this owner and asset`);
      }
    }
    tags.push(
      entry.signature === undefined
        ? ['accept', entry.caip19, address]
        : ['accept', entry.caip19, address, entry.signature],
    );
  }
  return { kind: KIND_PAYTO, created_at: input.createdAt ?? nowSecs(), tags, content: '' };
}

export interface ParsedPayto {
  targets: PayoutTarget[];
  /** `accept` entries dropped: an unknown asset, a malformed address, or a proof that fails. */
  rejected: { tag: readonly string[]; reason: 'unknown_asset' | 'bad_address' | 'bad_proof' }[];
}

/**
 * The payout targets an owner's 10133 declares, from its `accept` tags only.
 *
 * A bare NIP-A3 `payto` tag names no asset and no network environment, so it is
 * shown to generic clients but never paid to by elisym: a payment always goes to
 * an `accept` address for the exact CAIP-19 id. An `accept` tag whose wallet
 * proof is present but wrong is DROPPED, not downgraded - a wrong proof is
 * evidence of a mistake or of tampering, and neither is an address to pay.
 *
 * The caller has already checked the event's signature and that its author is
 * the owner.
 */
export function parsePayto(event: Pick<NostrEvent, 'pubkey' | 'tags'>): ParsedPayto {
  const candidates = new Map<string, PayoutTarget>();
  const badProof = new Set<string>();
  const rejected: ParsedPayto['rejected'] = [];
  for (const tag of tagsNamed(event.tags, 'accept')) {
    const [, caip19Id, rawAddress, signature] = tag;
    const caip19 = caip19Id === undefined ? undefined : parseCaip19(caip19Id);
    if (!caip19) {
      rejected.push({ tag, reason: 'unknown_asset' });
      continue;
    }
    const address =
      rawAddress === undefined ? undefined : canonicalPayoutAddress(caip19.chain, rawAddress);
    if (!address) {
      rejected.push({ tag, reason: 'bad_address' });
      continue;
    }
    const key = `${caip19.id}|${address}`;
    let walletSigned = false;
    if (signature !== undefined && signature !== '') {
      walletSigned = verifyPaytoProof({
        chain: caip19.chain,
        address,
        ownerPubkey: event.pubkey,
        caip19: caip19.id,
        signature,
      });
      if (!walletSigned) {
        rejected.push({ tag, reason: 'bad_proof' });
        badProof.add(key);
        continue;
      }
    }
    // Repeats of one address count once: signed if any copy carries a good proof.
    const earlier = candidates.get(key);
    if (earlier === undefined) {
      candidates.set(key, { caip19, address, walletSigned });
    } else if (walletSigned) {
      earlier.walletSigned = true;
    }
  }
  // A wrong proof anywhere condemns the address, whatever other copies say.
  const targets = [...candidates.entries()]
    .filter(([key]) => !badProof.has(key))
    .map(([, target]) => target);
  return { targets, rejected };
}
