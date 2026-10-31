/**
 * The payouts the owner signs (plan section 3): the assets a store takes on
 * its network and rails, the rows of the owner's own newest list (read in the
 * page, never from cloud-api), and the two owner events built from them - the
 * payout list and the store's AUTH (hosted, no expiry) - signed with the owner
 * key at the date the signing decision gave.
 */
import {
  buildPaytoEvent,
  buildStoreAuthEvent,
  canonicalPayoutAddress,
  parseCaip19,
  verifyPaytoProof,
} from '@elisym/commerce';
import { CHAINS, type ChainConfig, assetsFor } from '@elisym/pay-core';
import type { NostrEvent } from 'nostr-tools/pure';
import type { OwnerSigner } from './owner-key';

/** One asset a payout can take. */
export interface PayoutAsset {
  caip19: string;
  /** What the merchant reads: the coin and its chain (a testnet by its own name). */
  label: string;
  family: 'solana' | 'evm';
  /** The rail it is paid on (the chain slug: `solana`, `tempo`, `ethereum`, `arbitrum`, `base`). */
  rail: string;
}

/** A payout as it is signed into the list: an `accept` entry. */
export interface PayoutRow {
  caip19: string;
  address: string;
  /** The payout wallet's proof (it agreed to be paid for this owner and asset); none for an unproved row. */
  signature?: string;
}

/**
 * Every asset a payout takes on this store: each coin of each registry chain
 * of the store's network whose rail the store has on (`rails`: the chain
 * slugs - `solana`, `tempo`, `ethereum`, `arbitrum`, `base`): the node refuses
 * a payout on a rail its config lacks.
 */
export function payoutAssets(
  network: 'mainnet' | 'devnet',
  rails: ReadonlySet<string>,
): PayoutAsset[] {
  const assets: PayoutAsset[] = [];
  const chains: readonly ChainConfig[] = Object.values(CHAINS);
  for (const chain of chains) {
    if (chain.network !== network || !rails.has(chain.slug)) {
      continue;
    }
    const chainLabel =
      chain.chainName ?? (chain.network === 'mainnet' ? 'Solana' : 'Solana devnet');
    for (const asset of assetsFor(chain.slug, chain.network)) {
      if (asset.mint === undefined) {
        continue;
      }
      const caip19 = `${chain.caip2}/${chain.family === 'solana' ? 'token' : 'erc20'}:${asset.mint}`;
      // Only what every reader takes: an id commerce cannot parse is no payout.
      if (parseCaip19(caip19) !== undefined) {
        assets.push({
          caip19,
          label: `${asset.symbol} on ${chainLabel}`,
          family: chain.family,
          rail: chain.slug,
        });
      }
    }
  }
  return assets;
}

/** The owner's list as the console starts from it: the rows it keeps, and how many it could not. */
export interface ListRows {
  rows: PayoutRow[];
  /**
   * Entries no reader takes (an unknown asset, a bad address or proof, a second address for a
   * coin), and entries on an asset this store does not take (a rail it lacks, another network).
   */
  dropped: number;
}

/**
 * The rows of a signed payout list, read as `parsePayto` reads them: each
 * entry an asset commerce parses, its canonical address, and its proof when it
 * has one that verifies (an empty proof is none); one address per asset, the
 * first, as the node takes them; and only on the assets this store takes
 * (`allowed`: the CAIP-19 ids of `payoutAssets` for its network and rails),
 * since the node refuses a payout on a rail its config lacks. Anything else is
 * counted as dropped.
 */
export function payoutRows(list: NostrEvent | undefined, allowed: ReadonlySet<string>): ListRows {
  const rows: PayoutRow[] = [];
  let dropped = 0;
  for (const tag of list?.tags ?? []) {
    if (tag[0] !== 'accept') {
      continue;
    }
    const [, caip19 = '', rawAddress = '', signature = ''] = tag;
    const parsed = parseCaip19(caip19);
    const address =
      parsed === undefined ? undefined : canonicalPayoutAddress(parsed.chain, rawAddress);
    const proved =
      signature === '' ||
      (parsed !== undefined &&
        address !== undefined &&
        list !== undefined &&
        verifyPaytoProof({
          chain: parsed.chain,
          address,
          ownerPubkey: list.pubkey,
          caip19,
          signature,
        }));
    if (
      address === undefined ||
      !proved ||
      !allowed.has(caip19) ||
      rows.some((row) => row.caip19 === caip19)
    ) {
      dropped += 1;
      continue;
    }
    rows.push({ caip19, address, ...(signature === '' ? {} : { signature }) });
  }
  return { rows, dropped };
}

/** An address as the list carries it, for this asset; undefined when it is not one. */
export function payoutAddress(caip19: string, address: string): string | undefined {
  const parsed = parseCaip19(caip19);
  return parsed === undefined ? undefined : canonicalPayoutAddress(parsed.chain, address.trim());
}

/**
 * The owner's two events at `createdAt` (the signing decision's date, the
 * local clock): the payout list of these rows, and the store's AUTH in hosted
 * mode with no expiry, naming `operator`.
 */
export function signOwnerEvents(input: {
  signer: OwnerSigner;
  storePubkey: string;
  operator: string;
  rows: readonly PayoutRow[];
  createdAt: number;
}): { payoutList: NostrEvent; auth: NostrEvent } {
  const payoutList = input.signer.sign(
    buildPaytoEvent({
      ownerPubkey: input.signer.pubkey,
      accept: input.rows.map((row) => ({
        caip19: row.caip19,
        address: row.address,
        ...(row.signature === undefined ? {} : { signature: row.signature }),
      })),
      createdAt: input.createdAt,
    }),
  );
  const auth = input.signer.sign(
    buildStoreAuthEvent({
      storePubkey: input.storePubkey,
      mode: 'hosted',
      operator: input.operator,
      createdAt: input.createdAt,
    }),
  );
  return { payoutList, auth };
}
