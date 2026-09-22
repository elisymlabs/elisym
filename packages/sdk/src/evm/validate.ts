/**
 * The customer's side of a Tempo payment request: everything that must be true
 * BEFORE any money moves.
 *
 * Two halves, because they have different shapes. `validateTempoPaymentRequest`
 * is synchronous and reads nothing: it compares the request against the card
 * the price came from, the fee the chain says is due, and the caller's own
 * bounds. `checkTempoReceivePolicies` is the half that needs the chain - a
 * TIP-403 policy can refuse a transfer that otherwise succeeds, parking the
 * money with the guard and leaving the job unpaid, so both destinations are
 * asked before the customer signs anything.
 *
 * Order matters and is fixed: the chain gate comes before any money check that
 * is about THIS request - the fee arithmetic, the card's price, the clock - the
 * way the Solana validator puts the network gate first. A request settling
 * somewhere else must never reach the fee arithmetic. The session cap is the
 * one exception, and it is not one in substance: the parser enforces it while
 * reading the amount, before anything at all has been decided, and the code
 * that enforced it a second time down here was removed as unreachable.
 */

import type { Asset } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import { isVirtualEvmAddress, normalizeEvmAddress } from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import { parseAnyPaymentRequest, resolveAssetFromPaymentRequestV2 } from '../payment/schema-v2';
import type { PaymentValidationError } from '../types';
import type { Eip1193Client } from './client';
import { checkEvmChain, MAX_EVM_FEE_BPS } from './config';
import { TEMPO_UNPAYABLE_ADDRESSES } from './constants';
import { canReceiveFrom } from './policy';

/** How long a request may sit unpaid before its window is too short to be worth starting. */
export const MIN_PAY_WINDOW_SECS = 120;

/**
 * An asset's full key, with the mint read the way every other address on this
 * rail is read: case-insensitively.
 *
 * `assetKey` interpolates the mint verbatim, which is right for a base58 mint
 * and wrong for a hex one. A card or a session asset built from an explorer
 * value or from `getAddress()` carries a mint in EIP-55, and comparing that
 * verbatim refuses a perfectly good request with a message that says the two
 * coins differ while spelling the same one twice. A mint this rail cannot read
 * as an address is left exactly as it came.
 */
function coinKey(asset: Pick<Asset, 'chain' | 'token' | 'mint'>): string {
  // Every field `assetKey` interpolates is read as a string first, because it
  // builds a template and a symbol or a null-prototype object throws there -
  // in a file that guards a dozen other "cast past the type" shapes and whose
  // contract is to refuse, never to throw. A field that is not a string
  // becomes the empty key part it already is to a comparison: two assets that
  // differ in it still differ.
  const chain = typeof asset.chain === 'string' ? asset.chain : '';
  const token = typeof asset.token === 'string' ? asset.token : '';
  const mint =
    typeof asset.mint === 'string' ? (normalizeEvmAddress(asset.mint) ?? asset.mint) : undefined;
  // `assetKey` types `chain` as a `ChainSlug`, and the whole point here is the
  // value that is NOT one, so the key is built the way that function builds it
  // rather than through it.
  return mint === undefined ? `${chain}:${token}` : `${chain}:${token}:${mint}`;
}

export interface TempoPaymentCard {
  recipient: string;
  asset: Asset;
  /** The card's own price. ABSENT means a bound of zero, never "no bound". */
  jobPriceSubunits?: bigint;
}

interface TempoPaymentLimits {
  /**
   * The chain this customer is willing to pay on - its own environment's. It
   * must be a REGISTRY entry: the asset check below rests on the registry
   * holding the request's coin for this chain and network.
   */
  chain: ChainConfig;
  /** The payer's own address. It can be neither destination: such a leg proves nothing. */
  payer: string;
  /** The session cap, in the asset's subunits. */
  maxAmountSubunits?: bigint;
  /** The fee the chain says is due, read from the config contract. */
  protocolFeeBps: number;
  /** The treasury the chain names. Only meaningful at a fee above zero. */
  treasury: string;
  nowSecs?: number;
}

/**
 * What the request is checked AGAINST - and it is a union on purpose. A bounds
 * value with neither a card nor an agreed asset and cap binds nothing at all:
 * every recipient and every amount would be acceptable, which is the one shape
 * this function must never be handed. It does not typecheck.
 */
export type TempoPaymentBounds = TempoPaymentLimits &
  (
    | { card: TempoPaymentCard; expectedAsset?: Asset }
    | {
        card?: undefined;
        /** Without a card, the asset and the cap ARE the binding, so both are required. */
        expectedAsset: Asset;
        maxAmountSubunits: bigint;
      }
  );

function refuse(code: PaymentValidationError['code'], message: string): PaymentValidationError {
  return { code, message };
}

/**
 * The schema is the first gate, and most of what it refuses has a better name
 * than "invalid json": a chain this SDK does not know, an asset that is not a
 * CAIP-19 id of it, an amount over the session cap. The message already names
 * the field; this puts the right CODE on it, so a caller switching on the code
 * does not have to read English.
 */
function parseFailureCode(error: {
  code: string;
  message: string;
}): PaymentValidationError['code'] {
  if (error.code === 'unsupported_version') {
    return 'unsupported_version';
  }
  if (error.code === 'amount_exceeds_max') {
    return 'invalid_amount';
  }
  if (error.code === 'schema') {
    if (/\bchain\b/.test(error.message)) {
      return 'unsupported_chain';
    }
    if (/\basset\b/.test(error.message)) {
      return 'invalid_asset';
    }
    if (/\brecipient\b/.test(error.message)) {
      return 'invalid_recipient_address';
    }
    if (/\bfee_address\b/.test(error.message)) {
      return 'fee_address_mismatch';
    }
    if (/\bfee_amount\b/.test(error.message)) {
      return 'fee_amount_mismatch';
    }
    if (/\bamount\b/.test(error.message)) {
      return 'invalid_amount';
    }
    // A schema failure naming none of the fields above is a malformed request,
    // not an amount problem: `memo`, `created_at`, `expiry_secs`, `v` and a
    // root-level failure all used to report as `invalid_amount`, which is the
    // wrong code for a caller that switches on it rather than reading English.
    return 'invalid_json';
  }
  return 'invalid_json';
}

/**
 * Validate a payment request a provider sent, against the card it was quoted
 * from and the fee the chain says is due. `null` means it may be paid.
 *
 * Every branch refuses. There is no path where an unreadable field, an unknown
 * asset or an absent price is treated as permission - the money is the
 * customer's, and the only safe default is not to spend it.
 */
export function validateTempoPaymentRequest(
  requestJson: string,
  bounds: TempoPaymentBounds,
): PaymentValidationError | null {
  // The bounds' own SHAPE, before anything is read out of it - and that has
  // to mean BEFORE the parse below, which reads `maxAmountSubunits` off
  // them. Round 13 put these guards after it, so `bounds` of `null` still
  // threw on the very first read and the guard written for exactly that
  // case could only ever fire for a primitive. A caller that
  // casts past the type reaches this function with `card: null` or no chain at
  // all, and every one of those dies on a property read - this function's
  // contract is to refuse, never to throw, and seventeen sibling shapes
  // already do.
  if (typeof bounds !== 'object' || bounds === null) {
    return refuse('invalid_bounds', 'These bounds are not an object.');
  }
  if (typeof bounds.chain !== 'object' || bounds.chain === null) {
    return refuse('invalid_bounds', 'These bounds name no chain to pay on.');
  }
  if (bounds.card !== undefined && (typeof bounds.card !== 'object' || bounds.card === null)) {
    return refuse('invalid_bounds', 'These bounds carry a card that is not a card.');
  }
  // The card's ASSET has its own guard, because the coin comparison below
  // reads `.mint` off it. A discovered card gets its asset from
  // `resolveKnownAsset`, which answers `undefined` for a coin the registry does
  // not carry - and with an `expectedAsset` present beside it, the `??` never
  // fires and the read is reached. Refuse, as every sibling shape does.
  if (
    bounds.card !== undefined &&
    (typeof bounds.card.asset !== 'object' || bounds.card.asset === null)
  ) {
    return refuse('invalid_bounds', 'These bounds carry a card whose asset is not an asset.');
  }
  if (
    bounds.expectedAsset !== undefined &&
    (typeof bounds.expectedAsset !== 'object' || bounds.expectedAsset === null)
  ) {
    return refuse('invalid_bounds', 'These bounds carry an asset that is not an asset.');
  }

  // The session cap is enforced HERE, by the parse gate, for both versions -
  // there is no second check below, and adding one would be unreachable.
  const parsed = parseAnyPaymentRequest(requestJson, {
    ...(bounds.maxAmountSubunits === undefined
      ? {}
      : { maxAmountSubunits: bounds.maxAmountSubunits }),
  });
  if (!parsed.ok) {
    return refuse(parseFailureCode(parsed.error), parsed.error.message);
  }
  if (parsed.version !== 2) {
    return refuse(
      'unsupported_version',
      `This is a version ${parsed.version} payment request; a Tempo payment is version 2.`,
    );
  }
  const request = parsed.data;

  // Every one of these is lowercased below, which THROWS on anything that is
  // not a string - and this function's contract is to refuse, never to throw.
  const addresses = [
    bounds.payer,
    bounds.treasury,
    ...(bounds.card === undefined ? [] : [bounds.card.recipient]),
  ];
  if (addresses.some((address) => typeof address !== 'string')) {
    return refuse('invalid_bounds', 'These bounds carry an address that is not a string.');
  }

  // The chain gate FIRST, before any money check. A chain the registry does
  // not carry never reaches here - the v2 schema refuses it, and
  // `parseFailureCode` gives that refusal its `unsupported_chain` code.
  if (request.chain !== bounds.chain.caip2) {
    return refuse(
      'chain_mismatch',
      `Chain mismatch: this customer pays on ${bounds.chain.caip2}, and the request settles ` +
        `on ${request.chain}. Cross-chain payments are not possible.`,
    );
  }

  const asset = resolveAssetFromPaymentRequestV2(request);
  if (asset === undefined) {
    return refuse(
      'invalid_asset',
      `The request names ${request.asset}, which is not a coin this SDK knows on that chain.`,
    );
  }
  // A resolved asset is a coin of THIS environment by construction: the
  // resolver looks it up through the request chain's own environment, and the
  // gate above has already settled that the request chain is this one.
  if (
    bounds.card !== undefined &&
    bounds.expectedAsset !== undefined &&
    coinKey(bounds.card.asset) !== coinKey(bounds.expectedAsset)
  ) {
    // The union allows both, and `??` takes the card's - silently dropping the
    // asset the session agreed to. Two bounds that name different coins are
    // not a bound at all; which one wins should not be decided here.
    return refuse(
      'invalid_bounds',
      `These bounds disagree about the coin: the card pays ${bounds.card.asset.token} and ` +
        `the session agreed ${bounds.expectedAsset.token}.`,
    );
  }
  const agreed = bounds.card?.asset ?? bounds.expectedAsset;
  if (agreed === undefined) {
    // Unreachable for a caller that typechecks - the bounds union requires one
    // of the two - and a refusal rather than a silent pass for one that casts.
    return refuse('invalid_asset', 'These bounds name no asset to pay, so nothing may be paid.');
  }
  if (coinKey(agreed) !== coinKey(asset)) {
    return refuse(
      'asset_mismatch',
      `Asset mismatch: agreed to pay ${coinKey(agreed)}, but the request debits ${coinKey(asset)}.`,
    );
  }

  if (bounds.card !== undefined && request.recipient !== bounds.card.recipient.toLowerCase()) {
    return refuse(
      'recipient_mismatch',
      `Recipient mismatch: the card names ${bounds.card.recipient}, the request pays ` +
        `${request.recipient}.`,
    );
  }
  // Four protocol system accounts and the burn address. Money sent to any of
  // them is gone, and the fee sink is excluded from every leg match by name -
  // a payment there could never be read back as delivered.
  const destinations = [request.recipient, request.fee_address];
  const unpayable = destinations.find(
    (destination) => destination !== undefined && TEMPO_UNPAYABLE_ADDRESSES.includes(destination),
  );
  if (unpayable !== undefined) {
    return refuse(
      'invalid_recipient_address',
      `${unpayable} is a protocol address; a payment to it is not a payment.`,
    );
  }
  // Normalized through the same helper the async half uses, so the two halves
  // of this gate accept exactly the same spellings: lowercasing here while the
  // other side anchors on a literal `0x` let a `0X` payer clear the validator
  // and then fail the policy check for ever - a refusal either way, but one
  // the customer could never act on.
  const payer = normalizeEvmAddress(bounds.payer) ?? '';
  if (payer === '' || isVirtualEvmAddress(payer)) {
    // The CALLER's own address, so the caller's own code: telling a customer
    // whose wallet address is malformed that the PROVIDER named a bad
    // recipient is a lie about which address is wrong, and it sends them
    // looking for another provider for ever.
    return refuse('invalid_bounds', `Not an address this rail can pay from: ${bounds.payer}.`);
  }
  // A leg whose sides are equal moves nothing and counts for nothing, so a
  // request pointed back at the payer can only ever waste the gas.
  if (payer === request.recipient || payer === request.fee_address) {
    return refuse(
      'self_payment',
      "This request pays the customer's own address, which settles nothing.",
    );
  }

  // `NaN` compares FALSE against every one of the three time gates below, so
  // an unusable clock would open all of them at once - a request that expired
  // a day ago and one dated a year ahead both become payable. `Number.isFinite`
  // does not coerce, so it also catches a string of seconds, which would turn
  // `now + MIN_PAY_WINDOW_SECS` into string concatenation.
  const now = bounds.nowSecs ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) {
    return refuse('invalid_bounds', `These bounds carry no usable clock: ${bounds.nowSecs}.`);
  }
  if (request.created_at > now + MIN_PAY_WINDOW_SECS) {
    return refuse(
      'future_timestamp',
      `The request is dated ${request.created_at - now} seconds in the future.`,
    );
  }
  const expiresAt = request.created_at + request.expiry_secs;
  if (expiresAt <= now) {
    return refuse('expired', `The request expired ${now - expiresAt} seconds ago.`);
  }
  if (expiresAt - now < MIN_PAY_WINDOW_SECS) {
    return refuse(
      'expired',
      `Only ${expiresAt - now} seconds are left on this request; a payment needs at least ` +
        `${MIN_PAY_WINDOW_SECS}.`,
    );
  }

  const feeProblem = checkFee(request, bounds);
  if (feeProblem !== null) {
    return feeProblem;
  }

  const amount = BigInt(request.amount);
  const cap = bounds.maxAmountSubunits;
  const price = bounds.card?.jobPriceSubunits;
  if (
    (cap !== undefined && typeof cap !== 'bigint') ||
    (price !== undefined && typeof price !== 'bigint')
  ) {
    // Cast past the type and `amount > priceBound` compares a bigint against a
    // string, which is a relational comparison and false for every large
    // amount - so the card's price would bound nothing at all.
    return refuse('invalid_bounds', 'These bounds carry a price that is not a number of subunits.');
  }
  if (bounds.card === undefined && cap === undefined) {
    // Unreachable for a caller that typechecks - without a card the union
    // requires the cap - and the same refusal the asset half already makes for
    // one that casts. Neither half of the binding is present here: no card to
    // fix the recipient, no cap to fix the amount, so every address and every
    // amount would be acceptable.
    return refuse('invalid_bounds', 'These bounds bound no amount, so nothing may be paid.');
  }
  if (bounds.card !== undefined) {
    // An absent price is a bound of ZERO, not the absence of a bound: a card
    // that never published a price cannot charge for anything.
    const priceBound = bounds.card.jobPriceSubunits ?? 0n;
    if (amount > priceBound) {
      return refuse(
        'invalid_amount',
        `The request asks for ${request.amount}, above the ${priceBound} this card published.`,
      );
    }
  }
  return null;
}

/**
 * The fee leg must be EXACTLY what the chain says, or absent exactly when the
 * chain says there is no fee. A provider that names its own address as the
 * treasury, or rounds the fee down, is taking elisym's cut.
 */
function checkFee(
  request: ParsedPaymentRequestV2,
  bounds: TempoPaymentBounds,
): PaymentValidationError | null {
  // Read before it is used: the fee arithmetic THROWS on a rate that is not a
  // whole number of basis points, and this function's whole contract is that
  // it returns a refusal instead of throwing.
  if (
    !Number.isInteger(bounds.protocolFeeBps) ||
    bounds.protocolFeeBps < 0 ||
    bounds.protocolFeeBps > MAX_EVM_FEE_BPS
  ) {
    return refuse(
      'invalid_bounds',
      `The chain answered a protocol fee of ${bounds.protocolFeeBps} bps, which is not a fee.`,
    );
  }
  if (bounds.protocolFeeBps === 0) {
    if (request.fee_address !== undefined || request.fee_amount !== undefined) {
      return refuse(
        'invalid_fee_params',
        'The request carries a fee leg, and the chain says the protocol fee is zero.',
      );
    }
    return null;
  }
  if (request.fee_address === undefined || request.fee_amount === undefined) {
    return refuse(
      'missing_fee',
      `The chain charges ${bounds.protocolFeeBps} bps and the request carries no fee leg.`,
    );
  }
  const expected = calculateProtocolFeeSubunits(BigInt(request.amount), bounds.protocolFeeBps);
  if (request.fee_address !== bounds.treasury.toLowerCase()) {
    return refuse(
      'fee_address_mismatch',
      `The fee leg pays ${request.fee_address}; the chain names ${bounds.treasury}.`,
    );
  }
  if (BigInt(request.fee_amount) !== expected) {
    return refuse(
      'fee_amount_mismatch',
      `The fee leg is ${request.fee_amount}; ${bounds.protocolFeeBps} bps of ${request.amount} ` +
        `is ${expected}.`,
    );
  }
  return null;
}

export interface ReceivePolicyCheck {
  /** The chain the policies live on. Read before anything is asked of it. */
  chain: ChainConfig;
  token: string;
  payer: string;
  recipient: string;
  /** The treasury, when a fee leg is due. */
  feeAddress?: string;
}

export type ReceivePolicyVerdict =
  | { ok: true }
  | { ok: false; leg: 'provider' | 'fee'; reason: 'blocked' | 'unreadable'; message: string };

/**
 * Ask the chain whether each destination will actually accept this token from
 * this payer, before anything is signed.
 *
 * A blocked transfer SUCCEEDS: the funds sit with the guard, the memo log is
 * never emitted, and the provider reads the payment as never sent. The customer
 * has paid and has nothing. So an UNREADABLE answer refuses too - zero is the
 * accepting value of the second word, and a short answer must never decode as
 * permission.
 */
export async function checkTempoReceivePolicies(
  client: Eip1193Client,
  check: ReceivePolicyCheck,
): Promise<ReceivePolicyVerdict> {
  // The check's own SHAPE first, as the sync half does with its bounds. This
  // function's contract is to return a verdict, never to throw, and both
  // `check.token` and `check.chain.caip2` are read below - the chain inside a
  // message template, which throws only AFTER the reads have been made.
  if (typeof check !== 'object' || check === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: 'This policy check is not an object.',
    };
  }
  if (typeof check.chain !== 'object' || check.chain === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: 'This policy check names no chain to read policies on.',
    };
  }
  // The registry lives at the same system address on both Tempo networks and
  // answers plausibly on either, so asking the wrong one is not an error the
  // read itself can report: measured, a receiver that refuses on its own chain
  // answers `(1, 0)` - open - on the other.
  // This function's contract is to return a verdict, never to throw: every
  // address below is spliced into a calldata template, which throws on
  // anything that is not a string.
  //
  // Case-INSENSITIVE, like every other address gate a caller's own value
  // reaches: a wallet's `getAddresses()` answers EIP-55, and refusing that
  // spelling here would refuse the customer's own address before a single rpc
  // call. The calldata template lowercases what it splices, so nothing
  // downstream cares. (`isEvmWireAddress` belongs on values that arrived on
  // the WIRE, where lowercase is the format; these arrive from the caller.)
  const asked = [
    check.token,
    check.payer,
    check.recipient,
    // The only optional one. Absent means there is no fee leg to ask about;
    // present and not an address is the same error as the other three, and
    // exempting `undefined` wholesale is what the round-8 bounds guard got
    // wrong one file over.
    ...(check.feeAddress === undefined ? [] : [check.feeAddress]),
  ];
  // NORMALIZED once, here, and every gate below reads the normalized value.
  //
  // Accepting a spelling is not the same as carrying it: a gate that took
  // `0X...` while `isVirtualEvmAddress` (which anchors on a lowercase prefix)
  // answered `false` for the very same string would wave an alias past the two
  // TIP-1022 guards - and this is the one function whose `ok` is permission to
  // move money. So the spelling a wallet hands us is accepted and then
  // forgotten; `null` here is "not an address", exactly as before.
  // `normalizeEvmAddress` answers `undefined` for exactly what
  // `isEvmAddressFormat` refuses, and lowercasing never breaks the format - so
  // re-running the format check here would be a guard no test could kill.
  const normalized = asked.map((address) =>
    typeof address === 'string' ? normalizeEvmAddress(address) : undefined,
  );
  if (normalized.some((address) => address === undefined)) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: 'This policy check was handed something that is not an address.',
    };
  }
  const [token, payer, recipient, feeAddress] = normalized as string[];
  const onThisChain = await checkEvmChain(client, check.chain).catch(() => null);
  if (onThisChain === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `Could not confirm the endpoint is ${check.chain.caip2}; refusing to read a policy blind.`,
    };
  }
  if (isVirtualEvmAddress(payer)) {
    // The same TIP-1022 split as a virtual destination, on the sending side:
    // the registry would answer about the alias while the transfer is
    // evaluated against its master.
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `${payer} is a virtual address; the policy that applies is its master's.`,
    };
  }
  const legs: { leg: 'provider' | 'fee'; to: string }[] = [
    { leg: 'provider', to: recipient },
    ...(feeAddress === undefined ? [] : [{ leg: 'fee' as const, to: feeAddress }]),
  ];
  // The five addresses the sync half refuses outright, refused here too. This
  // half is the last gate before signing and the only one that PERMITS money
  // to move, and a system address carries no policy - so the registry answers
  // `(1, 0)`, open, and the read alone would wave the burn address through.
  // `unreadable` rather than `blocked`: "ask that destination to open its
  // policy" is not advice anyone can act on about the fee sink.
  const unpayable = legs.find(({ to }) => TEMPO_UNPAYABLE_ADDRESSES.includes(to));
  if (unpayable !== undefined) {
    return {
      ok: false,
      leg: unpayable.leg,
      reason: 'unreadable',
      message: `${unpayable.to} is a protocol address; a payment to it is not a payment.`,
    };
  }
  for (const { leg, to } of legs) {
    if (isVirtualEvmAddress(to)) {
      // TIP-1022: the registry answers for the ALIAS, which can never carry a
      // policy, while the transfer is resolved to its master and the master's
      // policy is what blocks it. The one read this function exists to make is
      // meaningless here, so it is not made.
      return {
        ok: false,
        leg,
        reason: 'unreadable',
        message: `${to} is a virtual address; its receive policy is its master's, which cannot be read.`,
      };
    }
    const allowed = await canReceiveFrom(client, { token, sender: payer, recipient: to });
    if (allowed === null) {
      return {
        ok: false,
        leg,
        reason: 'unreadable',
        message: `Could not read whether ${to} accepts ${token}; refusing to pay blind.`,
      };
    }
    if (!allowed) {
      return {
        ok: false,
        leg,
        reason: 'blocked',
        message:
          `${to} does not accept this token from this address: the transfer would succeed on ` +
          `chain and the money would sit with the guard, out of reach of both of you.`,
      };
    }
  }
  // Every answer above came from an endpoint that named this chain before the
  // first read. `ok` is permission to move money, so it is asked once more -
  // the registry lives at the same address on both networks and answers
  // plausibly on either, which is exactly how a mid-call network switch would
  // turn a refusal into a yes.
  if ((await checkEvmChain(client, check.chain).catch(() => null)) === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `${check.chain.caip2} could not be confirmed after the reads; refusing to pay blind.`,
    };
  }
  return { ok: true };
}
