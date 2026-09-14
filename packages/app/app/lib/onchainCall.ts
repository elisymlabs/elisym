/**
 * Turning a verified on-chain call into something a person can judge.
 *
 * Everything here is derived from what the CLIENT decoded and simulated. The
 * provider's own words (`explain`) travel separately and are labelled as the
 * agent's, never mixed into these rows - which is why this file never reads
 * `explain` at all.
 */

import {
  KNOWN_ASSETS,
  NATIVE_SOL,
  ONCHAIN_REFUSAL_HEADLINES,
  parseAssetAmount,
  parseOnchainCallEnvelope,
  resolveKnownAsset,
  toDTag,
  type Asset,
  type CapabilityCard,
  type OnchainCallFacts,
  type OnchainDescriptor,
  type OnchainRefusalReason,
} from '@elisym/sdk';
// `SendTransactionError` is the only @solana/web3.js import here: it is the one
// way to tell a preflight rejection from a send whose outcome is unknown. Same
// accepted bridge as the confirm sheet's `VersionedTransaction`.
import { SendTransactionError } from '@solana/web3.js';
import Decimal from 'decimal.js-light';
import { compactZeros } from './formatPrice';

/**
 * Cloned like `formatPrice`'s: a 1-lamport fee must render as `0.000000001`,
 * not as exponential notation that `compactZeros` would pass through untouched.
 */
const AmountDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 50 });

/**
 * Subunits to display units, symbol-free. Built from the bigint's string form,
 * so a large amount never loses precision through a JS double - and the caller
 * puts the symbol next to it rather than getting it baked in.
 */
function displayAmount(subunits: bigint, decimals: number): string {
  return new AmountDecimal(subunits.toString()).div(new AmountDecimal(10).pow(decimals)).toString();
}

/**
 * An asset the card does not denominate, seen only as a mint in a simulated
 * delta. Formatted as raw subunits rather than guessed decimals: showing "1.5"
 * for something whose decimals we do not know would be worse than showing the
 * integer the chain actually moved.
 */
function unknownMintAmount(subunits: bigint): string {
  return `${subunits} subunits`;
}

/** One line of "what this call does to your wallet". */
export interface CallMovement {
  /** `-` when value leaves, `+` when it arrives. */
  direction: '-' | '+';
  /** Formatted amount in display units. */
  amount: string;
  symbol: string;
  /** True for the asset the capability published its ceilings in. */
  isCardAsset: boolean;
}

/** A standing approval the call would leave behind. */
export interface CallGrant {
  delegate: string;
  account: string;
  amount: string;
  symbol: string;
}

export interface CallView {
  movements: CallMovement[];
  grants: CallGrant[];
  /** Programs the call's own instructions target. */
  programs: string[];
  /** Programs that only ran inside the simulated CPIs. */
  innerPrograms: string[];
  /** Network fee in SOL, already formatted. */
  fee: string;
  /** True when nothing at all leaves or arrives - an approve-only call, say. */
  movesNothing: boolean;
  /**
   * Writable accounts the verifier could not attribute to the signer. The
   * ceilings say nothing about these, so the sheet must show them and must
   * never describe such a call as moving nothing.
   */
  unattributed: string[];
}

/**
 * The asset a descriptor denominates its ceilings in, when this build actually
 * knows it. A card's own `decimals`/`symbol` are provider-controlled: trusting
 * them would let a capability declare 9 decimals over a 6-decimal mint and make
 * a 500-token outflow read as `0.5` in the sheet a human is about to approve.
 * Unknown mint means amounts are shown in raw subunits instead - the same rule
 * this file already applies to every other mint in a call.
 */
export function descriptorAsset(descriptor: OnchainDescriptor): Asset | null {
  return resolveKnownAsset('solana', descriptor.token, descriptor.mint) ?? null;
}

/**
 * A known asset identified by its mint alone. A simulated delta carries no
 * token id, and every mint in `KNOWN_ASSETS` is network-specific, so the mint
 * is enough to name one unambiguously.
 */
function knownAssetByMint(mint: string): Asset | undefined {
  return KNOWN_ASSETS.find((candidate) => candidate.mint === mint);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * A ceiling as the sheet states it. An asset this build does not know has no
 * decimals worth trusting, so its bound reads in subunits - the same rule every
 * other amount here follows.
 */
export function ceilingLabel(subunits: bigint, asset: Asset | null): string {
  return asset
    ? `${compactZeros(displayAmount(subunits, asset.decimals))} ${asset.symbol}`
    : `${subunits} subunits`;
}

/**
 * Keep only what forms a valid amount: digits and a single decimal point, with
 * at most `decimals` fractional digits. Mirrors the delegation panel's cap
 * field - a locale comma or a stray letter must never reach the amount parser
 * and come back to the customer as "this call could not be checked".
 */
export function sanitizeAmountInput(raw: string, decimals: number): string {
  const digitsAndDots = raw.replace(/[^0-9.]/g, '');
  const firstDot = digitsAndDots.indexOf('.');
  if (firstDot === -1) {
    return digitsAndDots;
  }
  const intPart = digitsAndDots.slice(0, firstDot);
  if (decimals === 0) {
    return intPart;
  }
  const fracPart = digitsAndDots
    .slice(firstDot + 1)
    .replace(/\./g, '')
    .slice(0, decimals);
  return `${intPart}.${fracPart}`;
}

/**
 * Map the verifier's facts onto rows for the confirm sheet. Amounts are
 * formatted through the same decimal helpers as prices, so a call and a price
 * never disagree about how a number looks.
 */
export function toCallView(
  facts: Partial<OnchainCallFacts>,
  descriptor: OnchainDescriptor,
): CallView {
  const asset = descriptorAsset(descriptor);
  const movements: CallMovement[] = (facts.deltas ?? []).map((delta) =>
    movementOf(delta, descriptor, asset),
  );
  const grants: CallGrant[] = (facts.grants ?? []).map((grant) => ({
    delegate: grant.delegate,
    account: grant.account,
    amount:
      grant.mint === descriptor.mint && asset
        ? compactZeros(displayAmount(grant.subunits, asset.decimals))
        : unknownMintAmount(grant.subunits),
    symbol: grant.mint === descriptor.mint && asset ? asset.symbol : grant.mint,
  }));
  return {
    movements,
    grants,
    programs: facts.programs ?? [],
    innerPrograms: facts.innerPrograms ?? [],
    fee: compactZeros(displayAmount(facts.feeLamports ?? 0n, NATIVE_SOL.decimals)),
    movesNothing: movements.length === 0,
    unattributed: facts.unattributed ?? [],
  };
}

/**
 * One delta as a row. Four cases, kept flat: the asset the card denominates,
 * native SOL (fee and rent), another asset this build knows by mint (a swap's
 * proceeds), and a mint we know nothing about - which is shown in subunits
 * rather than dressed up with guessed decimals.
 */
function movementOf(
  delta: OnchainCallFacts['deltas'][number],
  descriptor: OnchainDescriptor,
  asset: Asset | null,
): CallMovement {
  const direction = delta.subunits < 0n ? '-' : '+';
  const magnitude = absolute(delta.subunits);
  if (delta.mint === descriptor.mint) {
    return {
      direction,
      amount: asset
        ? compactZeros(displayAmount(magnitude, asset.decimals))
        : unknownMintAmount(magnitude),
      symbol: asset?.symbol ?? descriptor.mint ?? descriptor.token,
      isCardAsset: true,
    };
  }
  if (delta.mint === undefined) {
    return {
      direction,
      amount: compactZeros(displayAmount(magnitude, NATIVE_SOL.decimals)),
      symbol: 'SOL',
      isCardAsset: false,
    };
  }
  const known = knownAssetByMint(delta.mint);
  return {
    direction,
    amount: known
      ? compactZeros(displayAmount(magnitude, known.decimals))
      : unknownMintAmount(magnitude),
    symbol: known?.symbol ?? delta.mint,
    isCardAsset: false,
  };
}

/**
 * The headline for a refusal, shared word-for-word with the MCP client.
 *
 * The fallback is unreachable today - the record is total over the reason union
 * - and is kept only for a client running against an SDK that has since added a
 * reason. It says what MCP's own fallback says, for the same reason the record
 * exists: the same rejection must not read two ways.
 */
export function refusalHeadline(reason: OnchainRefusalReason): string {
  return ONCHAIN_REFUSAL_HEADLINES[reason] ?? 'Refusing to sign this call.';
}

/**
 * Whether a program is one the client can name. Everything else is shown as an
 * unknown program - deliberately, since an unrecognized program is exactly the
 * case a customer should look at twice.
 */
const NAMED_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
};

export function programLabel(programId: string): string {
  return NAMED_PROGRAMS[programId] ?? 'unknown program';
}

/** True when at least one program in the call is not one we can name. */
export function hasUnknownProgram(view: CallView): boolean {
  return [...view.programs, ...view.innerPrograms].some(
    (programId) => NAMED_PROGRAMS[programId] === undefined,
  );
}

/**
 * A ceiling the customer typed, in the same units the box shows. An asset this
 * build does not know has no decimals we trust, so the box is subunits there
 * and the string is read as an integer.
 */
function parseCeiling(typed: string, asset: Asset | null): bigint {
  if (/^0+(?:\.0+)?$/.test(typed)) {
    return 0n;
  }
  if (!asset) {
    if (!/^\d+$/.test(typed)) {
      throw new Error(`Enter the limit in subunits (whole number); got "${typed}".`);
    }
    return BigInt(typed);
  }
  return parseAssetAmount(asset, typed);
}

/**
 * A ceiling the customer typed, never above what the capability published. An
 * empty box is refused rather than read as the published maximum: "I want no
 * allowance" and "give it everything the capability asked for" must not be the
 * same gesture.
 */
export function narrowedCeiling(
  typed: string,
  asset: Asset | null,
  published: bigint,
  label: string,
): bigint {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    throw new Error(`Enter a ${label} limit - type 0 to allow nothing.`);
  }
  const requested = parseCeiling(trimmed, asset);
  return requested < published ? requested : published;
}

/** The largest subunit amount `parseAssetAmount` will take back. */
const MAX_PARSEABLE_SUBUNITS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The number the limit box starts at. A card may publish a ceiling above what
 * `parseAssetAmount` will take back (it works in `Number` subunits), and seeding
 * the box with it would make the customer's very first click fail on a figure
 * they never typed. Clamped to the largest amount that round-trips - which only
 * ever LOWERS, so the box can never seed above the published ceiling.
 */
export function seedLimit(published: bigint, asset: Asset | null): string {
  const seed = published > MAX_PARSEABLE_SUBUNITS ? MAX_PARSEABLE_SUBUNITS : published;
  return asset ? displayAmount(seed, asset.decimals) : seed.toString();
}

/**
 * Whether a failed send may have reached the cluster.
 *
 * With preflight on, `SendTransactionError` is thrown only when the node
 * answered the RPC call with an error - it simulates before forwarding, so
 * those bytes provably never went out and the customer may safely sign again.
 * Every other failure (a dropped connection, a timeout, a malformed response)
 * leaves the question open, and an open question must be treated as "sent":
 * recording it is what stops a second, real call.
 */
export function wasBroadcast(error: unknown): boolean {
  return !(error instanceof SendTransactionError);
}

/**
 * Where a `SendTransactionError` message stops being about the transaction.
 *
 * The sheet sends with `skipPreflight: false`, so web3.js always builds the
 * `simulate` shape: `Simulation failed. \nMessage: <what went wrong>. \n`,
 * followed by up to ten preflight log lines emitted by the program the PROVIDER
 * chose to list, followed by a fixed instruction to the DEVELOPER to call
 * `getLogs()`. Both tails must go, and the logs are absent on the commonest
 * failure of all - an expired blockhash, which never reaches a program - so a
 * split on the logs alone leaves the developer text behind. (The `send` shape,
 * reachable only under `skipPreflight: true`, separates its logs with a space
 * rather than a newline; this pattern does not cover it, and nothing here
 * produces it.)
 */
const SEND_ERROR_TAIL = /\nLogs: |\nCatch the /;

/** The full stop and whitespace web3.js leaves on the half that is kept. */
const TRAILING_PUNCTUATION = /[\s.]+$/;

/**
 * What to tell the customer about a failed sign-and-send, from any error.
 *
 * For a `SendTransactionError`, neither the provider's log lines nor an
 * instruction aimed at whoever wrote this app belongs in the client's own
 * refusal paragraph, so only the transaction-level part is kept. Every error
 * is then stripped of its trailing full stop, because every caller writes a
 * sentence around it ("... never reached the network: X. Check it again") and
 * would otherwise double the punctuation. That applies just as much to a wallet
 * rejection ("User rejected the request.") as to web3.js's own tail, which is
 * why this runs on the general path and not only the send one.
 * Lives beside `wasBroadcast` - same error type, same concern - and is tested,
 * because its correctness rests on a third-party message format.
 */
export function sendFailureDetail(error: unknown): string {
  const whole = error instanceof Error ? error.message : String(error);
  const transactionLevel =
    error instanceof SendTransactionError ? whole.split(SEND_ERROR_TAIL)[0] : whole;
  return (transactionLevel ?? whole).replace(TRAILING_PUNCTUATION, '');
}

/**
 * The verdict to show when a STORED claim takes the screen back from this flow.
 *
 * This flow's own terminal answer outranks the stored one for the same
 * signature. The `failed` write can fail to commit - storage refused it - which
 * leaves the store saying `sent` for a call this client watched revert on
 * chain. Reading that back put "this client could not confirm whether it
 * landed" in the same panel as the refusal saying it failed on chain: two
 * sentences that contradict each other, one of which tells the customer to go
 * and make a second real call.
 *
 * Only `failed` and `landed` are kept. `sent` is not a verdict, and a stored
 * one may be newer than this tab's.
 */
export function keptCallStatus(
  blocking: string,
  stored: 'sent' | 'landed' | 'failed' | undefined,
  local: { signature: string | null; status: 'sent' | 'landed' | 'failed' | null },
): 'sent' | 'landed' | 'failed' {
  const ownTerminal =
    local.signature === blocking && local.status !== null && local.status !== 'sent';
  return ownTerminal && local.status !== null ? local.status : (stored ?? 'sent');
}

/**
 * The signature that should stop the customer signing this job again, if any.
 *
 * A `failed` record is a call the chain rejected: it moved nothing, so it is
 * not a reason to block the retry the sheet offers. Anything else - `landed`,
 * or `sent` with no verdict yet - is, because a second check rebuilds the call
 * against a fresh blockhash and that signature WOULD land.
 */
export function blockingCallSignature(record: {
  callSignature?: string;
  callStatus?: 'sent' | 'landed' | 'failed';
}): string | undefined {
  return record.callStatus === 'failed' ? undefined : record.callSignature;
}

/**
 * `toDTag`, for strings a PROVIDER chose.
 *
 * It throws on anything with no ASCII alphanumeric in it - `''`, `'-'`, a tab -
 * and a card's `capabilities` entries are validated for type and length but
 * never for being d-taggable. This runs inside the chat's entry map during
 * render, so an uncaught throw takes the whole thread down for anyone who opens
 * that agent. A name that cannot be a tag simply matches no tag.
 */
function safeDTag(value: string): string | null {
  try {
    return toDTag(value);
  } catch {
    return null;
  }
}

/**
 * The capability card behind an entry, but only when it published an on-chain
 * promise. Without that promise there is nothing to verify a call against, so
 * the entry stays an ordinary text result.
 *
 * The same matcher the MCP client uses: a job's capability tag can be a
 * capability KEYWORD rather than a card name, and matching on the name alone
 * would leave a paid call with no sheet to sign it in. Only cards carrying a
 * descriptor can have built the call, and two of those answering to one tag
 * means the promise being checked is not necessarily the one that was bought -
 * so that is refused rather than resolved by picking the first.
 *
 * A card answering BY NAME is the one the tag addresses, and it decides the
 * question even when it carries no promise at all. Without that rule the
 * narrowing to descriptor-bearing cards runs in the wrong direction: a provider
 * publishes a plain text capability, and a second card whose `capabilities`
 * list SQUATS that capability's name while carrying a wide descriptor. The
 * customer buys the text capability - the browser writes its name as the tag -
 * the provider answers with a call, and the squatter is the only descriptor
 * answering, so the sheet binds the call to a promise the customer never looked
 * at. The keyword fallback is only reached when no card answers by name.
 */
export function onchainCardFor(
  cards: CapabilityCard[],
  capability: string,
): (CapabilityCard & { onchain: OnchainDescriptor }) | undefined {
  const answering = cards.filter(
    (candidate) =>
      safeDTag(candidate.name) === capability ||
      candidate.capabilities?.some((entry) => safeDTag(entry) === capability),
  );
  const promised = answering.filter((candidate) => candidate.onchain !== undefined);
  const card = promised.length === 1 ? promised[0] : undefined;
  if (!card?.onchain) {
    return undefined;
  }
  const addressedByName = answering.some(
    (candidate) => candidate !== card && safeDTag(candidate.name) === capability,
  );
  return addressedByName ? undefined : { ...card, onchain: card.onchain };
}

/**
 * A job result is a signable call only when it parses as the envelope shape.
 * Cheap gate so the chat does not try to verify every text result.
 */
export function looksLikeCall(result: string | undefined): boolean {
  if (!result) {
    return false;
  }
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) {
    return false;
  }
  return trimmed.includes('"elisym_call"');
}

/**
 * Whether a job result really IS a call envelope, not merely a JSON blob that
 * mentions one. `looksLikeCall` is a substring gate, so a docs or support
 * capability answering a question ABOUT `elisym_call` satisfies it - and any
 * text the chat swaps out for a notice about calls must be a call, or the
 * notice is a false statement about the agent's answer. The cheap gate runs
 * first; the schema parse only ever sees JSON that already looks the part.
 */
export function isCallEnvelope(result: string | undefined): boolean {
  return looksLikeCall(result) && parseOnchainCallEnvelope(result) !== null;
}
