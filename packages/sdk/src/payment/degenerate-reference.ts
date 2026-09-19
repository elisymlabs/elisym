import {
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveEventAuthorityAddress,
  deriveNetworkStatsAddress,
} from '@elisym/config-client';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from '@solana-program/token';
import { type Address, address, isAddress } from '@solana/kit';
import { ELISYM_PROTOCOL_TAG, getProtocolProgramId } from '../constants';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS_STR } from '../onchain/checks';
import { SYSTEM_PROGRAM_ADDRESS_STR } from '../onchain/constants';
import type { Network, PaymentRequestData } from '../types';
import { TOKEN_2022_PROGRAM_ADDRESS_STR, resolveAssetFromPaymentRequest } from './assets';

/**
 * A reference key that is also an address the payment already involves.
 *
 * Harm runs both ways, and the customer's half is the worse one. Verification
 * lists the reference's recent history to find the payment
 * (`getSignaturesForAddress`), so a reference equal to the recipient lists the
 * provider's whole wallet: the customer's transfer falls off the far end of
 * the window and is never found again - money paid for work that is then
 * refused. A reference equal to the treasury drowns it the same way, whether
 * or not the treasury takes a fee in this particular transaction, because the
 * listing is of an ADDRESS and not of a transaction. On the provider's side
 * the presence check becomes a tautology and de-duplication stops meaning
 * anything.
 *
 * The CLASS cannot be closed. A reference equal to the system program, to the
 * asset mint or to the payer is degenerate for the same reason, and the honest
 * invariant - "an address that appears only in transactions for this request" -
 * is not expressible as a list; the payer is not even known when the request is
 * checked. This is a denylist of the addresses a payment for THIS request is
 * computed from, and it is hardening: every request the SDK builds carries a
 * randomly generated reference, so a false refusal here is unreachable.
 */
export type DegenerateReferenceCode = 'degenerate_reference';

/**
 * Cap on cached address sets. Reached only by a hosting provider: on the
 * customer path the synchronous half runs alone and never derives anything, and
 * a single provider's recipient and fee address are constant. Many recipients
 * in one process, times a few mints, is what makes the key space unbounded over
 * a process lifetime.
 */
/**
 * NOT KILLED BY ANY TEST: removing the eviction below costs memory in a
 * long-lived process and nothing else - no answer changes - so it is left
 * stated rather than measured.
 */
const MAX_CACHE_ENTRIES = 5_000;

const derivedCache = new Map<string, ReadonlySet<string>>();
let derivationCount = 0;

/** Test seam: the number of times an address set was actually derived. */
export function degenerateReferenceDerivations(): number {
  return derivationCount;
}

/** Test seam: drop the cache and the counter. */
export function resetDegenerateReferenceCache(): void {
  derivedCache.clear();
  derivationCount = 0;
}

/**
 * A guard against what a NODE or a hand-edited file answers, not against the
 * type. `Network` admits only these two, but the CLI reaches this with a
 * request parsed straight out of its own ledger by `JSON.parse`, with no schema
 * in between, so an unknown string is reachable at runtime.
 *
 * NO TEST KILLS THIS ON ITS OWN, and pretending otherwise would be worse than
 * saying so: `getProtocolProgramId` switches without a `default`, so an unknown
 * cluster already falls out of it as `undefined`, and removing this line
 * changes nothing observable today. It is here so the behaviour survives that
 * switch gaining a `default` that throws - which is the natural way to make it
 * total. Caught by diff review, not by the suite.
 */
function normalizeNetwork(value: unknown): Network | undefined {
  return value === 'mainnet' || value === 'devnet' ? value : undefined;
}

/**
 * The program id for a network we know, or `undefined`. Unknown network
 * means only the program-id-derived entries drop out - the rest of the denylist
 * needs no program id, and turning the whole check off would lose it exactly
 * where it remains fully computable.
 */
function programIdFor(network: Network | undefined): Address | undefined {
  return network === undefined ? undefined : getProtocolProgramId(network);
}

function tokenProgramOf(asset: { tokenProgram?: string }): string {
  return asset.tokenProgram ?? (TOKEN_PROGRAM_ADDRESS as string);
}

/**
 * Everything computable from the request and the config WITHOUT deriving a
 * program address. Throws on an unresolvable asset: the mint and its token
 * program are part of the comparison, so there is nothing to compare against
 * until the asset is known. The signature does not show this - callers that
 * have not already resolved the asset have to be ready for it.
 */
function staticDenylist(
  request: PaymentRequestData,
  programId: Address | undefined,
  treasury: Address,
): Set<string> {
  const asset = resolveAssetFromPaymentRequest(request);
  const denied = new Set<string>([
    ELISYM_PROTOCOL_TAG as string,
    request.recipient,
    // Both token programs, deliberately as a superset. A reference equal to
    // either drowns the payment in that program's global history whether or not
    // this request uses it, and dropping the one this asset does not use would
    // trade a real check for nothing: the reference is random, so the false
    // refusal this could theoretically cause is unreachable.
    TOKEN_PROGRAM_ADDRESS as string,
    TOKEN_2022_PROGRAM_ADDRESS_STR,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS as string,
    SYSTEM_PROGRAM_ADDRESS_STR,
    COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
    MEMO_PROGRAM_ADDRESS as string,
    // From the CONFIG, not the request: a third-party provider may leave
    // `fee_address` out entirely, and a reference equal to the treasury drowns
    // the payment in its history regardless.
    treasury as string,
  ]);
  if (request.fee_address !== undefined) {
    denied.add(request.fee_address);
  }
  if (asset.mint !== undefined) {
    denied.add(asset.mint);
  }
  if (programId !== undefined) {
    denied.add(programId as string);
  }
  return denied;
}

function cacheKey(
  request: PaymentRequestData,
  network: Network | undefined,
  programId: Address | undefined,
  asset: { mint?: string; tokenProgram?: string },
  treasury: Address,
): string {
  // `network` is in the key because `constants.ts` requires every
  // program-id-keyed cache to carry a network discriminator - devnet and
  // mainnet share one program id today. `fee_amount` is NOT: the set of
  // derived addresses does not depend on it, and keying on it would miss a
  // reference equal to the treasury's ATA on a zero-fee request. The treasury
  // IS in the key - it rotates on-chain, and a set cached against the old one
  // would survive the rotation and miss the new one.
  return JSON.stringify([
    network ?? null,
    programId ?? null,
    asset.mint ?? null,
    asset.tokenProgram ?? null,
    request.recipient,
    request.fee_address ?? null,
    treasury,
  ]);
}

/**
 * The derived half: program PDAs, and the associated-token accounts of every
 * owner the payment can credit.
 *
 * `findAssociatedTokenPda` encodes its owner and THROWS on a string that is not
 * an address, so every owner is guarded first. A malformed owner simply
 * contributes no ATA - "not degenerate" - and is caught, where it should be, by
 * the check that owns it: the recipient by request validation, the treasury by
 * the config reader. Guarding matters because none of the three is validated
 * on this path today: `verifyPayment` only checks the recipient for presence,
 * `fee_address` goes unchecked entirely when the fee is zero, and `treasury` is
 * typed as an `Address` while a plain-JS caller can put anything there.
 */
async function derivedDenylist(
  request: PaymentRequestData,
  programId: Address | undefined,
  asset: { mint?: string; tokenProgram?: string },
  treasury: Address,
): Promise<ReadonlySet<string>> {
  derivationCount += 1;
  const derived = new Set<string>();

  if (programId !== undefined) {
    derived.add((await deriveNetworkStatsAddress(programId)) as string);
    derived.add((await deriveEventAuthorityAddress(programId)) as string);
    const statsMint = asset.mint === undefined ? NATIVE_ASSET_SENTINEL : address(asset.mint);
    derived.add((await deriveAssetStatsAddress(programId, statsMint)) as string);
  }

  if (asset.mint !== undefined) {
    const mint = address(asset.mint);
    const tokenProgram = address(tokenProgramOf(asset));
    const owners = [request.recipient, request.fee_address, treasury as string];
    for (const owner of owners) {
      if (owner === undefined || !isAddress(owner)) {
        continue;
      }
      const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      derived.add(ata as string);
    }
  }
  return derived;
}

/**
 * The half that needs no `await`. Used on its own where the caller cannot be
 * asynchronous, and as the first pass everywhere else.
 */
export function degenerateReferenceSync(
  request: PaymentRequestData,
  network: Network,
  treasury: Address,
): DegenerateReferenceCode | undefined {
  const normalized = normalizeNetwork(request.network ?? network);
  return staticDenylist(request, programIdFor(normalized), treasury).has(request.reference)
    ? 'degenerate_reference'
    : undefined;
}

/**
 * The full check. Derives once per call - before any candidate loop, never
 * inside one - and caches the derived half.
 */
export async function degenerateReference(
  request: PaymentRequestData,
  network: Network,
  treasury: Address,
): Promise<DegenerateReferenceCode | undefined> {
  const synchronous = degenerateReferenceSync(request, network, treasury);
  if (synchronous !== undefined) {
    return synchronous;
  }
  const normalized = normalizeNetwork(request.network ?? network);
  const asset = resolveAssetFromPaymentRequest(request);
  // Resolved BEFORE the cache is consulted, so the key is complete whichever
  // way the lookup goes.
  const programId = programIdFor(normalized);
  const key = cacheKey(request, normalized, programId, asset, treasury);

  let derived = derivedCache.get(key);
  if (derived === undefined) {
    derived = await derivedDenylist(request, programId, asset, treasury);
    if (derivedCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = derivedCache.keys().next();
      if (!oldest.done) {
        derivedCache.delete(oldest.value);
      }
    }
    derivedCache.set(key, derived);
  }
  return derived.has(request.reference) ? 'degenerate_reference' : undefined;
}
