/**
 * Verifying USDC payments over EIP-3009 on Ethereum, Arbitrum and Base (the
 * `eip3009` rail) for direct-mode orders: the merchant side of the contract.
 *
 * A payment is bound to the order by its nonce (the order's derived `eip3009`
 * reference): an `AuthorizationUsed` from the USDC proxy IMMEDIATELY followed
 * by the `Transfer` it authorizes, to the payout, of at least a price. It pays
 * terms the store offered within the window before the leg's block time, lands
 * at or above the order's floor, is credited only at the chain's credit tag,
 * and is claimed once.
 *
 * Catch-up finds payments per PAYOUT, never per order (anyone can post orders
 * for free): the USDC transfers to each payout, each bound once through its
 * receipt (log index - 1) and cached, then matched to the open orders' nonces
 * on every sweep. No RPC answer is trusted as proof that a range is empty:
 * every block of an open order's window is scanned again and again while the
 * order is open, so a wrong `[]` or a failed read heals on a later pass.
 */
import { deriveOrderPaymentReference, parseCaip19 } from '@elisym/commerce';
import { mediumOf } from '@elisym/commerce/buyer';
import { type Asset, type ChainConfig, assetsFor, chainFor } from '@elisym/pay-core';
import {
  type Eip1193Client,
  type Eip3009TransferLog,
  EvmRpcError,
  checkEvmChain,
  createJsonRpcClient,
  findAssetTransferNear,
  listPayoutTransfers,
  readAuthorizationBinding,
  readBlockAtTag,
  readEip3009Legs,
  readImplementation,
} from '@elisym/pay-core/evm';
import { EIP3009_SLUGS, type MerchantConfig, isEip3009Slug } from './config';
import {
  CATCH_UP_SECS,
  EIP3009_BIND_READS,
  EIP3009_FAILURES_BEFORE_WARNING,
  EIP3009_RECENT_WINDOW_BLOCKS,
  EIP3009_START_CHECK_BACKOFF_SECS,
  EIP3009_SWEEP_REQUESTS,
  MAX_RECHECKS_PER_SWEEP,
  ORDER_SCAN_MARGIN_SECS,
  TERMS_WINDOW_SECS,
} from './constants';
import {
  type LedgerState,
  type MerchantOrder,
  type WebhookOutbox,
  claimPayment,
  openOrders,
  recordPayment,
} from './ledger';
import { orderProductD } from './products';
import type { CatchUpResult, PaymentCheck } from './solana';
import { FLOOR_MARGIN_SECS, blockAtTime, blockTime, orderFloor } from './tempo';
import { type OfferTerms, termsAt, termsSince, termsSinceAll } from './terms';

/** Whether this chain's RPC passed the start check: only then is it scanned. */
export type Eip3009Gate =
  | { kind: 'verified' }
  /** A transport or rate-limit failure: checked again at `nextAt`, not scanned meanwhile. */
  | { kind: 'deferred'; attempts: number; nextAt: number; problem: string }
  /** A wrong answer after start: not scanned until a restart. */
  | { kind: 'failed'; problem: string };

/** A scanned transfer to a payout, not yet bound to a nonce. */
interface PendingHit {
  hit: Eip3009TransferLog;
  /** Sweeps it waited without a binding read. */
  waited: number;
}

/** What one chain's scan keeps between sweeps, in memory (this run only). */
export interface Eip3009ScanMemory {
  /**
   * The aligned chunk (`block / rangeCap`) the full pass reads next, newest
   * first; `undefined`: the next pass starts at the credit-tag block.
   */
  passChunk?: number;
  /** The payouts the full pass already read in `passChunk`. */
  passDone: Set<string>;
  /**
   * Sweeps in a row whose read of a chunk or a hit failed, with the lowest
   * block each concerns and the sweep that last counted it.
   */
  failures: Map<string, { count: number; block: number; sweep: number }>;
  /** Sweeps run so far: a chunk read twice in one sweep fails once. */
  sweeps: number;
  /** Hits not bound yet (budget, an unreadable receipt, a mismatched implementation). */
  pending: Map<string, PendingHit>;
}

export interface Eip3009Context {
  client: Eip1193Client;
  /** The registry chain: its credit tag, log range cap and id. */
  chain: ChainConfig;
  /** The chain's USDC. */
  asset: Asset;
  /** The receipt medium of the chain (`base`, `base-devnet`, ...). */
  medium: string;
  storePubkey: string;
  /** Blocks per `eth_getLogs` call: the config's, at least the registry's. */
  rangeCap: number;
  /** With a webhook configured: a payment verified here queues its `order.paid` webhook. */
  outbox?: WebhookOutbox;
  /** Block timestamps read so far (the floor's binary search). */
  samples: Map<number, number>;
  scan: Eip3009ScanMemory;
  gate: Eip3009Gate;
}

/** How a hash came out, beyond Solana's verdicts. */
export type Eip3009Check =
  | PaymentCheck
  /** At the credit tag, no leg of this order's nonce to a payout of at least a price: set aside. */
  | { kind: 'no_leg' };

export function newScanMemory(): Eip3009ScanMemory {
  return { passDone: new Set(), failures: new Map(), pending: new Map(), sweeps: 0 };
}

/** The receipt mediums a store takes: Solana's and Tempo's when it has them, then each `eip3009` chain's. */
export function storeMediums(
  solana: string | undefined,
  tempo: string | undefined,
  contexts: readonly Pick<Eip3009Context, 'medium'>[],
): string[] {
  return [
    ...(solana === undefined ? [] : [solana]),
    ...(tempo === undefined ? [] : [tempo]),
    ...contexts.map((context) => context.medium),
  ];
}

/** The chain's name in the log. */
export function chainNameOf(context: Pick<Eip3009Context, 'chain'>): string {
  return context.chain.chainName ?? context.chain.caip2;
}

/**
 * One context per chain of the config's `evm` block, in the node's
 * environment: the registry chain and its USDC, the operator's RPC (no
 * public fallback: the start check qualifies it), not yet verified.
 */
export function eip3009ContextsFor(
  config: Pick<MerchantConfig, 'network' | 'evm'>,
  storePubkey: string,
  options: Eip3009RailOptions = {},
): Eip3009Context[] {
  const clientFor = options.clientFor ?? createJsonRpcClient;
  return EIP3009_SLUGS.flatMap((slug) => {
    const entry = config.evm?.[slug];
    if (entry === undefined) {
      return [];
    }
    const chain = chainFor(slug, config.network);
    const asset = assetsFor(slug, config.network).find((coin) => coin.eip712 !== undefined);
    const rangeCap = entry.logRangeCap ?? chain.logRangeCap;
    if (asset === undefined || rangeCap === undefined) {
      return [];
    }
    return [
      {
        client: clientFor(entry.rpcUrl),
        chain,
        asset,
        medium: mediumOf(chain),
        storePubkey,
        rangeCap,
        samples: new Map(),
        scan: newScanMemory(),
        gate: { kind: 'deferred', attempts: 0, nextAt: 0, problem: 'not checked yet' },
        ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
      },
    ];
  });
}

/** What builds a node's `eip3009` contexts: the webhook outbox, and (in tests) the RPC client. */
export interface Eip3009RailOptions {
  /** With a webhook configured: every payment verified on these chains queues its `order.paid`. */
  outbox?: WebhookOutbox;
  clientFor?: (rpcUrl: string) => Eip1193Client;
}

/** The CAIP-2 ids of the chains the config's `evm` block verifies: the offers the node honours there. */
export function eip3009ChainsOf(config: Pick<MerchantConfig, 'network' | 'evm'>): string[] {
  return EIP3009_SLUGS.filter((slug) => config.evm?.[slug] !== undefined).map(
    (slug) => chainFor(slug, config.network).caip2,
  );
}

/**
 * The `eip3009` rail of a starting node: one context per `evm` entry, each
 * through its start check. A wrong answer throws (start-up stops); a
 * transport failure leaves that chain deferred.
 */
export async function startEip3009Rail(
  config: Pick<MerchantConfig, 'network' | 'evm'>,
  storePubkey: string,
  options: Eip3009RailOptions & {
    now: number;
    log: (message: string) => void;
    check?: typeof startCheckEip3009;
  },
): Promise<Eip3009Context[]> {
  const contexts = eip3009ContextsFor(config, storePubkey, options);
  await startEip3009Chains(contexts, options.now, options.log, options.check);
  return contexts;
}

/** The order's EIP-3009 nonce: derived from the order alone, never stored. */
export function eip3009Nonce(order: MerchantOrder, storePubkey: string): string {
  return deriveOrderPaymentReference({
    storePubkey,
    buyerPubkey: order.buyerPubkey,
    orderId: order.orderId,
  }).eip3009.toLowerCase();
}

const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;

/**
 * The terms on this chain's USDC among `terms`. A "0"-priced term is never
 * payable from the widget and never counted: a zero threshold would let free
 * zero-value `Transfer` spam take every binding read.
 */
function chainTerms(terms: readonly OfferTerms[], context: Eip3009Context): OfferTerms[] {
  const mint = context.asset.mint?.toLowerCase();
  return terms.filter((each) => {
    const caip19 = parseCaip19(each.caip19);
    return (
      caip19?.chain.caip2 === context.chain.caip2 &&
      caip19.asset.mint?.toLowerCase() === mint &&
      POSITIVE_DECIMAL_RE.test(each.amount)
    );
  });
}

/** The terms of the order's own product on this chain a payment for it may pay. */
export function orderEip3009Candidates(
  state: LedgerState,
  order: MerchantOrder,
  context: Eip3009Context,
): OfferTerms[] {
  return chainTerms(
    termsSince(state.terms, orderProductD(order), order.createdAt - ORDER_SCAN_MARGIN_SECS),
    context,
  );
}

type TermVerdict = 'ask' | 'refused' | 'no_leg';

/**
 * Check one hash for `order`, against each candidate term (`minValue` = its
 * price): the first leg that pays credits, after the block-time guard (the
 * leg's block time falls in a standing period of the order's product with
 * exactly that caip19, payout and amount, and its block is not below the
 * order's floor) and the claim, taken right before the payment is recorded.
 * A leg below the credit tag, an unreadable or absent receipt, and a leg-less
 * receipt above the tag are asked again; only answers at the credit tag are
 * final (`refused`, `no_leg`). The fee is not read: this rail is fee 0 only, so
 * a leg below the price is never credited.
 */
export async function checkEip3009Payment(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  context: Eip3009Context,
): Promise<Eip3009Check> {
  if (order.paid !== undefined) {
    return order.paid.signature === hash
      ? { kind: 'paid', order }
      : { kind: 'refused', reason: 'order_already_paid' };
  }
  const candidates = orderEip3009Candidates(state, order, context);
  if (candidates.length === 0) {
    return { kind: 'refused', reason: 'not_a_payment_for_this_order' };
  }
  const nonce = eip3009Nonce(order, context.storePubkey);
  let floorRead: Promise<{ number: number; timestamp: number } | undefined> | undefined;
  const verdicts: TermVerdict[] = [];
  for (const terms of candidates) {
    const legs = await readEip3009Legs(context.client, hash, {
      chain: context.chain,
      asset: context.asset,
      nonce,
      to: terms.payout,
      minValue: BigInt(terms.amount),
    });
    if (legs.state === 'none') {
      verdicts.push(legs.final ? 'no_leg' : 'ask');
      continue;
    }
    if (legs.state !== 'paid') {
      verdicts.push('ask');
      continue;
    }
    const { leg } = legs;
    const at = await blockTime(context, leg.blockNumber);
    const floor = await (floorRead ??= orderFloor(context, order));
    if (at === undefined || floor === undefined) {
      verdicts.push('ask');
      continue;
    }
    // The block-time guard: only the order's own product, at exactly these terms.
    const offered = termsAt(state.terms, orderProductD(order), at).some(
      (standing) =>
        standing.caip19 === terms.caip19 &&
        standing.payout === terms.payout &&
        standing.amount === terms.amount,
    );
    if (leg.blockNumber < floor.number || !offered) {
      verdicts.push('refused');
      continue;
    }
    if (!claimPayment(state, `${context.chain.caip2}:${leg.txHash}:${nonce}`, order.key)) {
      return { kind: 'refused', reason: 'claimed_by_another_order' };
    }
    recordPayment(
      order,
      {
        signature: leg.txHash,
        amount: leg.value.toString(),
        fee: '0',
        blockTime: at,
        caip19: terms.caip19,
        medium: context.medium,
      },
      context.outbox,
    );
    return { kind: 'paid', order };
  }
  if (verdicts.includes('ask')) {
    return { kind: 'ask_again' };
  }
  if (verdicts.every((verdict) => verdict === 'refused')) {
    return { kind: 'refused', reason: 'not_a_payment_for_this_order' };
  }
  return { kind: 'no_leg' };
}

/** Keep a final verdict for (order, hash): neither is checked again. */
export function recordEip3009Check(order: MerchantOrder, hash: string, check: Eip3009Check): void {
  if (check.kind === 'refused' && order.refusedTxs?.includes(hash) !== true) {
    order.refusedTxs = [...(order.refusedTxs ?? []), hash];
  } else if (check.kind === 'no_leg' && order.noLegTxs?.includes(hash) !== true) {
    order.noLegTxs = [...(order.noLegTxs ?? []), hash];
  }
}

/** A hash this order already judged finally. */
function judged(order: MerchantOrder, hash: string): boolean {
  return order.refusedTxs?.includes(hash) === true || order.noLegTxs?.includes(hash) === true;
}

function warn(result: CatchUpResult, message: string): void {
  (result.warnings ??= []).push(message);
}

/**
 * Count one read that failed (or forget the failures of one that worked); a
 * read failing on `EIP3009_FAILURES_BEFORE_WARNING` sweeps in a row is reported.
 */
function noteRead(
  context: Eip3009Context,
  result: CatchUpResult,
  key: string,
  block: number,
  ok: boolean,
  what: string,
): void {
  const { failures } = context.scan;
  if (ok) {
    failures.delete(key);
    return;
  }
  const known = failures.get(key);
  const sweep = context.scan.sweeps;
  if (known?.sweep === sweep) {
    return;
  }
  const count = (known?.count ?? 0) + 1;
  failures.set(key, { count, block, sweep });
  if (count >= EIP3009_FAILURES_BEFORE_WARNING) {
    const name = chainNameOf(context);
    warn(
      result,
      `${name}: ${what} failed on ${count} sweeps in a row; older payments on ${name} may be missed`,
    );
  }
}

function bindingKey(context: Eip3009Context, hit: Eip3009TransferLog): string {
  return `${context.chain.caip2}:${hit.txHash}:${hit.logIndex}`;
}

/** Each payout of this chain in reach of the open orders, with the smallest value that can pay it. */
function payoutThresholds(state: LedgerState, context: Eip3009Context, oldest: number) {
  const thresholds = new Map<string, bigint>();
  for (const terms of chainTerms(
    termsSinceAll(state.terms, oldest - ORDER_SCAN_MARGIN_SECS),
    context,
  )) {
    const amount = BigInt(terms.amount);
    const known = thresholds.get(terms.payout);
    thresholds.set(terms.payout, known === undefined || amount < known ? amount : known);
  }
  return thresholds;
}

/** Drop what no open order can reach any more: bindings, waiting hits and failures below `block`. */
function forgetBelow(state: LedgerState, context: Eip3009Context, block: number): void {
  const prefix = `${context.chain.caip2}:`;
  for (const [key, binding] of Object.entries(state.eip3009Bindings)) {
    if (key.startsWith(prefix) && binding.blockNumber < block) {
      delete state.eip3009Bindings[key];
    }
  }
  for (const [key, pending] of context.scan.pending) {
    if (pending.hit.blockNumber < block) {
      context.scan.pending.delete(key);
    }
  }
  for (const [key, failure] of context.scan.failures) {
    if (failure.block < block) {
      context.scan.failures.delete(key);
    }
  }
}

interface ScanWindow {
  /** The credit-tag block: nothing above it is scanned. */
  head: { number: number; hash: string };
  /** The oldest open order's floor. */
  floor: number;
  /** The recent window's lowest block. */
  recentFrom: number;
}

/**
 * Scan the payouts: the recent window every sweep, outside any budget, then
 * the full pass by `EIP3009_SWEEP_REQUESTS`, both newest first, in chunks
 * aligned to `rangeCap` (so a chunk failing on two passes is the same chunk).
 * Every transfer of at least its payout's threshold that is not bound yet
 * waits for a binding read.
 */
async function scanPayouts(
  context: Eip3009Context,
  window: ScanWindow,
  thresholds: ReadonlyMap<string, bigint>,
  result: CatchUpResult,
): Promise<void> {
  const cap = context.rangeCap;
  const { head, floor } = window;
  const found: Eip3009TransferLog[] = [];
  const readChunk = async (payout: string, chunk: number, from: number, to: number) => {
    const walk = await listPayoutTransfers(context.client, context.asset, payout, from, to, {
      rangeCap: cap,
    });
    noteRead(
      context,
      result,
      `${payout}:${chunk}`,
      from,
      walk.complete,
      `blocks ${from}-${to} of transfers to ${payout}`,
    );
    if (walk.complete) {
      found.push(...walk.logs);
    }
    return walk.requests;
  };
  const span = (chunk: number, low: number): [number, number] => [
    Math.max(chunk * cap, low),
    Math.min(chunk * cap + cap - 1, head.number),
  ];
  for (
    let chunk = Math.floor(head.number / cap);
    chunk >= Math.floor(window.recentFrom / cap) && window.recentFrom <= head.number;
    chunk -= 1
  ) {
    const [from, to] = span(chunk, window.recentFrom);
    for (const payout of thresholds.keys()) {
      await readChunk(payout, chunk, from, to);
    }
  }
  const { scan } = context;
  let budget = EIP3009_SWEEP_REQUESTS;
  scan.passChunk ??= Math.floor(head.number / cap);
  // The pass ends in the sweep that reads its last chunk, budget left or not.
  while (scan.passChunk !== undefined) {
    const chunk: number = scan.passChunk;
    if (chunk < Math.floor(floor / cap)) {
      // The pass reached the floor: the next one starts again from the head.
      scan.passChunk = undefined;
      scan.passDone.clear();
      break;
    }
    const [from, to] = span(chunk, floor);
    if (from <= to) {
      for (const payout of thresholds.keys()) {
        if (budget <= 0) {
          break;
        }
        if (!scan.passDone.has(payout)) {
          budget -= await readChunk(payout, chunk, from, to);
          scan.passDone.add(payout);
        }
      }
      // The budget ran out inside this chunk: the next sweep reads the rest of it.
      if ([...thresholds.keys()].some((payout) => !scan.passDone.has(payout))) {
        break;
      }
    }
    scan.passChunk = chunk - 1;
    scan.passDone.clear();
  }
  for (const hit of found) {
    const threshold = thresholds.get(hit.to);
    if (threshold === undefined || hit.value < threshold) {
      continue;
    }
    // The newest sighting replaces an older one: a log first read from another
    // fork or a lagging backend would never match its receipt.
    const key = bindingKey(context, hit);
    scan.pending.set(key, { hit, waited: scan.pending.get(key)?.waited ?? 0 });
  }
}

/**
 * Bind waiting hits under `EIP3009_BIND_READS`: first those whose hash an open
 * order reported on this chain, then half newest first and half oldest first.
 * A binding (or `unbound`) is cached only from a trusted receipt (pay-core's
 * `readAuthorizationBinding`), and `unbound` only while the proxy runs the
 * pinned implementation; an unreadable receipt waits for the next sweep.
 */
async function bindPending(
  state: LedgerState,
  context: Eip3009Context,
  open: readonly MerchantOrder[],
  implementationMatches: boolean,
  result: CatchUpResult,
): Promise<void> {
  const { pending } = context.scan;
  for (const [key] of pending) {
    if (state.eip3009Bindings[key] !== undefined) {
      pending.delete(key);
    }
  }
  const reported = new Set(
    open.flatMap((order) =>
      order.reportedTxs.filter((tx) => order.reportedMedia?.[tx] === context.medium),
    ),
  );
  const entries = [...pending.entries()];
  const first = entries.filter(([, waiting]) => reported.has(waiting.hit.txHash));
  const rest = entries
    .filter(([, waiting]) => !reported.has(waiting.hit.txHash))
    .sort(
      ([, left], [, right]) =>
        right.hit.blockNumber - left.hit.blockNumber || right.hit.logIndex - left.hit.logIndex,
    );
  const chosen = first.slice(0, EIP3009_BIND_READS);
  const left = EIP3009_BIND_READS - chosen.length;
  const newest = Math.ceil(left / 2);
  const older = rest.slice(newest);
  chosen.push(
    ...rest.slice(0, newest),
    ...older.slice(Math.max(0, older.length - (left - newest))),
  );
  const read = new Set<string>();
  for (const [key, waiting] of chosen) {
    read.add(key);
    const binding = await readAuthorizationBinding(
      context.client,
      context.chain,
      context.asset,
      waiting.hit,
    );
    noteRead(
      context,
      result,
      `bind:${key}`,
      waiting.hit.blockNumber,
      binding.state !== 'unreadable',
      `the receipt of ${waiting.hit.txHash}`,
    );
    const { txHash, blockNumber } = waiting.hit;
    if (binding.state === 'bound') {
      state.eip3009Bindings[key] = {
        state: 'bound',
        txHash,
        blockNumber,
        authorizer: binding.authorizer,
        nonce: binding.nonce,
      };
      pending.delete(key);
    } else if (binding.state === 'unbound' && implementationMatches) {
      state.eip3009Bindings[key] = { state: 'unbound', txHash, blockNumber };
      pending.delete(key);
    }
  }
  let unread = 0;
  for (const [key, waiting] of pending) {
    if (!read.has(key)) {
      waiting.waited += 1;
      if (waiting.waited >= EIP3009_FAILURES_BEFORE_WARNING) {
        unread += 1;
      }
    }
  }
  if (unread > 0) {
    const name = chainNameOf(context);
    warn(
      result,
      `${name}: ${unread} transfer(s) to the payouts not read yet; older payments on ${name} may be missed`,
    );
  }
}

/**
 * The scan of one sweep: the credit-tag block `S`, the finalized block and the
 * oldest open order's floor; the USDC implementation at `S` (pinned by hash)
 * against the registry's; then the payouts, then the binding reads. A head
 * that cannot be read skips the scan this sweep (logged): cached bindings are
 * still matched.
 */
async function scanAndBind(
  state: LedgerState,
  context: Eip3009Context,
  open: readonly MerchantOrder[],
  now: number,
  result: CatchUpResult,
): Promise<void> {
  const name = chainNameOf(context);
  // `blockAtTime` clamps to the finalized block's catch-up lookback (about 30
  // minutes shallower than this time): still below every open order's floor.
  const horizon = await blockAtTime(
    context,
    now - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS - TERMS_WINDOW_SECS,
  );
  if (horizon !== undefined) {
    forgetBelow(state, context, horizon.number);
  }
  const oldest = Math.min(...open.map((order) => order.createdAt));
  const thresholds = payoutThresholds(state, context, oldest);
  if (thresholds.size === 0) {
    return;
  }
  const credit = context.chain.finality?.credit ?? 'finalized';
  const head = await readBlockAtTag(context.client, credit);
  const finalized = await readBlockAtTag(context.client, 'finalized');
  const floor = await blockAtTime(context, oldest - FLOOR_MARGIN_SECS);
  if (head === null || finalized === null || floor === undefined) {
    warn(
      result,
      `${name}: the chain's head could not be read; payments there were not scanned this time`,
    );
    return;
  }
  const pinned = context.asset.implementation?.toLowerCase();
  const implementation = await readImplementation(context.client, context.asset, {
    blockHash: head.hash,
  });
  const implementationMatches = implementation !== null && implementation === pinned;
  if (implementation === null) {
    warn(
      result,
      `${name}: the USDC implementation could not be read at block ${head.number}; no transfer is set aside as unbound this time`,
    );
  } else if (!implementationMatches) {
    warn(
      result,
      `WARNING: ${name}: the USDC proxy runs implementation ${implementation}, not the pinned ${pinned ?? '-'}: upgrade the node; no transfer is set aside as unbound meanwhile`,
    );
  }
  for (const [key, waiting] of context.scan.pending) {
    if (waiting.hit.blockNumber < floor.number) {
      context.scan.pending.delete(key);
    }
  }
  const slug = context.chain.slug;
  const recentBlocks = isEip3009Slug(slug) ? EIP3009_RECENT_WINDOW_BLOCKS[slug] : 0;
  await scanPayouts(
    context,
    {
      head,
      floor: floor.number,
      recentFrom: Math.max(floor.number, finalized.number - recentBlocks),
    },
    thresholds,
    result,
  );
  await bindPending(state, context, open, implementationMatches, result);
}

/**
 * Catch up on every open order on one `eip3009` chain. Reported hashes (their
 * receipt's medium names this chain) and scan-bound hits are judged under two
 * SEPARATE budgets of `MAX_RECHECKS_PER_SWEEP`, each oldest check first:
 * reports are free to send, and must never slow a scan-bound hit, which stands
 * for a real transfer of at least a price. A final verdict is kept per
 * (order, hash) and never checked again.
 */
export async function catchUpEip3009(
  state: LedgerState,
  context: Eip3009Context,
  now: number,
): Promise<CatchUpResult> {
  const result: CatchUpResult = { paid: [], incomplete: [] };
  const open = openOrders(state, now, CATCH_UP_SECS);
  context.scan.sweeps += 1;
  if (open.length === 0) {
    context.scan.passChunk = undefined;
    context.scan.passDone.clear();
    return result;
  }
  const checked = new Set<string>();
  const judge = async (queue: { order: MerchantOrder; hash: string; checkedAt: number }[]) => {
    queue.sort((left, right) => left.checkedAt - right.checkedAt);
    for (const { order, hash } of queue.slice(0, MAX_RECHECKS_PER_SWEEP)) {
      if (order.paid !== undefined) {
        continue;
      }
      checked.add(`${order.key} ${hash}`);
      order.recheckedAt = { ...order.recheckedAt, [hash]: now };
      const check = await checkEip3009Payment(state, order, hash, context);
      recordEip3009Check(order, hash, check);
      if (check.kind === 'paid') {
        result.paid.push(order);
      }
    }
  };
  const reported: { order: MerchantOrder; hash: string; checkedAt: number }[] = [];
  for (const order of open) {
    for (const hash of order.reportedTxs) {
      if (order.reportedMedia?.[hash] === context.medium && !judged(order, hash)) {
        reported.push({ order, hash, checkedAt: order.recheckedAt?.[hash] ?? 0 });
      }
    }
  }
  await judge(reported);
  await scanAndBind(state, context, open, now, result);
  const byNonce = new Map(open.map((order) => [eip3009Nonce(order, context.storePubkey), order]));
  const prefix = `${context.chain.caip2}:`;
  const bound = new Map<string, { order: MerchantOrder; hash: string; checkedAt: number }>();
  for (const [key, binding] of Object.entries(state.eip3009Bindings)) {
    if (!key.startsWith(prefix) || binding.state !== 'bound') {
      continue;
    }
    const order = byNonce.get(binding.nonce);
    const pair = `${order?.key ?? ''} ${binding.txHash}`;
    if (
      order === undefined ||
      order.paid !== undefined ||
      judged(order, binding.txHash) ||
      checked.has(pair)
    ) {
      continue;
    }
    bound.set(pair, {
      order,
      hash: binding.txHash,
      checkedAt: order.recheckedAt?.[binding.txHash] ?? 0,
    });
  }
  await judge([...bound.values()]);
  return result;
}

/** How a start check came out. */
export type Eip3009StartCheck =
  | { kind: 'passed'; warning?: string }
  /** The RPC answered wrongly: a config error for this chain. */
  | { kind: 'wrong'; problem: string }
  /** A transport or rate-limit failure: says nothing about the RPC, checked again later. */
  | { kind: 'transient'; problem: string };

/**
 * JSON-RPC error codes that say "not now" rather than "not this": a rate limit
 * (`-32005`, `-32011` as `mainnet.base.org` answers, 429) or an internal error.
 */
const TRANSIENT_RPC_CODES: readonly number[] = [-32005, -32011, -32603, 429];

/** HTTP statuses that say "not now": a timeout, a rate limit; every 5xx is one too. */
const TRANSIENT_HTTP_STATUSES: readonly number[] = [408, 429];

/** How pay-core's `createJsonRpcClient` words an HTTP status it got instead of an answer. */
const HTTP_STATUS_RE = /^rpc \S+ answered HTTP (\d{3})$/;

/** How pay-core's `createJsonRpcClient` words a body that is no JSON-RPC answer. */
const NOT_AN_ANSWER_RE =
  /^rpc \S+ answered (something that is not a JSON-RPC response|with neither a result nor an error|the wrong request id)$/;

/**
 * Whether a failed request says "not now" (a transport failure, a timeout, a
 * rate limit, a server error) or "not this" (a JSON-RPC refusal, an HTTP 4xx
 * such as a mistyped URL or a rejected key, a body that is no JSON-RPC answer).
 */
function classify(error: unknown): { transient: boolean; why: string } {
  if (error instanceof EvmRpcError) {
    const code = error.code;
    return {
      transient: code !== undefined && TRANSIENT_RPC_CODES.includes(code),
      why: `code ${code ?? 'none'}`,
    };
  }
  if (error instanceof SyntaxError) {
    return { transient: false, why: 'not JSON' };
  }
  if (error instanceof Error) {
    const status = HTTP_STATUS_RE.exec(error.message)?.[1];
    if (status !== undefined) {
      const code = Number(status);
      return {
        transient: code >= 500 || TRANSIENT_HTTP_STATUSES.includes(code),
        why: `HTTP ${code}`,
      };
    }
    if (NOT_AN_ANSWER_RE.test(error.message)) {
      return { transient: false, why: 'not a JSON-RPC answer' };
    }
    // A timeout, a dropped connection: `DOMException` has a numeric `code` too.
    return { transient: true, why: 'transport' };
  }
  // An error object as a wallet provider throws it: `{ code, message }`.
  const code: unknown =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'number') {
    return { transient: TRANSIENT_RPC_CODES.includes(code), why: `code ${code}` };
  }
  return { transient: true, why: 'transport' };
}

interface RecordedCall {
  method: string;
  /** Present when the request threw. */
  error?: { value: unknown };
}

/** A client that records every request's outcome: a failed check is judged by its last one. */
function recordingClient(client: Eip1193Client): { client: Eip1193Client; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      request: async (args) => {
        try {
          const value = await client.request(args);
          calls.push({ method: args.method });
          return value;
        } catch (error) {
          calls.push({ method: args.method, error: { value: error } });
          throw error;
        }
      },
    },
  };
}

/**
 * Why a step failed, judged by its last request (see `classify`): a transport,
 * rate-limit or server error is transient; a refusal, a null where data was
 * due, or an answer of the wrong shape is a wrong answer. Never "nothing there".
 */
function failureOf(calls: readonly RecordedCall[], mark: number, what: string): Eip3009StartCheck {
  const last = calls.slice(mark).at(-1);
  if (last?.error === undefined) {
    return {
      kind: 'wrong',
      problem: `${what}: the RPC's answer (${last?.method ?? 'none'}) was not usable`,
    };
  }
  const { transient, why } = classify(last.error.value);
  if (transient) {
    return { kind: 'transient', problem: `${what}: ${last.method} failed (${why})` };
  }
  return { kind: 'wrong', problem: `${what}: the RPC refused ${last.method} (${why})` };
}

/**
 * Whether the chain's RPC can serve the scan's window, in the REAL query
 * shape, with data (not merely no error): the chain id; one USDC `Transfer`
 * found near the 3-day-old floor, never searching past one `rangeCap` after
 * it (a provider that pruned history cannot pass by finding a recent one); the
 * same log found again by its recipient (`topics[2]`, the scan's shape) over
 * that window; and its old receipt, by hash. No transfer in the span is a
 * wrong answer on mainnet; on devnet (a thin testnet) a warning.
 */
export async function startCheckEip3009(
  context: Eip3009Context,
  now: number,
): Promise<Eip3009StartCheck> {
  const { client, calls } = recordingClient(context.client);
  const cap = context.rangeCap;
  // The search for a 3-day-old transfer never reaches further than the
  // registry's span: an operator's larger cap sizes requests, never what
  // counts as "three days back" (a provider keeping less history must fail).
  const span = Math.min(cap, context.chain.logRangeCap ?? cap);
  let chainId: bigint | null;
  try {
    chainId = await checkEvmChain(client, context.chain);
  } catch {
    return {
      kind: 'wrong',
      problem: `eth_chainId names another chain than ${chainNameOf(context)}`,
    };
  }
  if (chainId === null) {
    return failureOf(calls, 0, 'eth_chainId could not be read');
  }
  let mark = calls.length;
  const floor = await blockAtTime(
    { client, samples: new Map() },
    now - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS,
  );
  if (floor === undefined) {
    return failureOf(calls, mark, 'the blocks of three days back could not be read');
  }
  mark = calls.length;
  const near = await findAssetTransferNear(client, context.asset, floor.number, span);
  if (near.state === 'none') {
    const problem = `no USDC transfer in the ${span} blocks from block ${floor.number} (three days back)`;
    return context.chain.network === 'mainnet'
      ? { kind: 'wrong', problem: `${problem}: the RPC does not serve three days of logs` }
      : { kind: 'passed', warning: `${problem}: a thin testnet, the RPC is taken unchecked` };
  }
  if (near.state !== 'found') {
    return failureOf(calls, mark, 'the USDC transfers of three days back could not be read');
  }
  const { log } = near;
  mark = calls.length;
  const again = await listPayoutTransfers(
    client,
    context.asset,
    log.to,
    floor.number,
    floor.number + cap - 1,
    {
      rangeCap: cap,
    },
  );
  if (!again.complete) {
    return failureOf(calls, mark, `the transfers to ${log.to} could not be read`);
  }
  if (
    !again.logs.some(
      (each) =>
        each.txHash === log.txHash &&
        each.logIndex === log.logIndex &&
        each.blockHash === log.blockHash &&
        each.blockNumber === log.blockNumber &&
        each.from === log.from &&
        each.value === log.value,
    )
  ) {
    return {
      kind: 'wrong',
      problem: `asked for the transfers to ${log.to}, the RPC left out the one of ${log.txHash} it had found`,
    };
  }
  mark = calls.length;
  const receipt = await readAuthorizationBinding(client, context.chain, context.asset, log);
  if (receipt.state === 'unreadable') {
    return failureOf(
      calls,
      mark,
      `the receipt of ${log.txHash} (three days old) could not be read`,
    );
  }
  return { kind: 'passed' };
}

function backoffSecs(attempts: number): number {
  return (
    EIP3009_START_CHECK_BACKOFF_SECS[
      Math.min(attempts, EIP3009_START_CHECK_BACKOFF_SECS.length - 1)
    ] ?? 0
  );
}

/** A transient start check: the chain stays off, and is checked again after a pause. */
function defer(
  context: Eip3009Context,
  problem: string,
  now: number,
  log: (message: string) => void,
) {
  const attempts = context.gate.kind === 'deferred' ? context.gate.attempts : 0;
  context.gate = {
    kind: 'deferred',
    attempts: attempts + 1,
    nextAt: now + backoffSecs(attempts),
    problem,
  };
  log(
    `WARNING: ${chainNameOf(context)} RPC not yet verified (${problem}); payments there are not being scanned`,
  );
}

/**
 * Run each chain's start check before the node starts. Only a WRONG answer
 * stops start-up (worded with what failed); a transport or rate-limit failure
 * leaves that chain off, checked again on later sweeps, while every other rail
 * runs.
 */
export async function startEip3009Chains(
  contexts: readonly Eip3009Context[],
  now: number,
  log: (message: string) => void,
  check: typeof startCheckEip3009 = startCheckEip3009,
): Promise<void> {
  for (const context of contexts) {
    const outcome = await check(context, now);
    if (outcome.kind === 'wrong') {
      throw new Error(`${chainNameOf(context)} RPC failed the start check: ${outcome.problem}`);
    }
    if (outcome.kind === 'transient') {
      defer(context, outcome.problem, now, log);
      continue;
    }
    context.gate = { kind: 'verified' };
    if (outcome.warning !== undefined) {
      log(`warning: ${chainNameOf(context)}: ${outcome.warning}`);
    }
  }
}

/**
 * One sweep of one chain, behind its gate: a verified chain catches up; a
 * deferred one runs its start check again when due (and catches up at once
 * when it passes, from the oldest floor as usual); a check that then answers
 * wrongly keeps the chain off until a restart, never exiting the process.
 */
export async function sweepEip3009(
  state: LedgerState,
  context: Eip3009Context,
  now: number,
  log: (message: string) => void,
  deps: { check?: typeof startCheckEip3009; catchUp?: typeof catchUpEip3009 } = {},
): Promise<CatchUpResult> {
  const idle: CatchUpResult = { paid: [], incomplete: [] };
  const { gate } = context;
  if (gate.kind === 'failed') {
    return idle;
  }
  if (gate.kind === 'deferred') {
    if (now < gate.nextAt) {
      log(
        `WARNING: ${chainNameOf(context)} RPC not yet verified (${gate.problem}); payments there are not being scanned`,
      );
      return idle;
    }
    const outcome = await (deps.check ?? startCheckEip3009)(context, now);
    if (outcome.kind === 'transient') {
      defer(context, outcome.problem, now, log);
      return idle;
    }
    if (outcome.kind === 'wrong') {
      context.gate = { kind: 'failed', problem: outcome.problem };
      log(
        `error: ${chainNameOf(context)} RPC failed the start check: ${outcome.problem}; payments there are not scanned until a restart`,
      );
      return idle;
    }
    context.gate = { kind: 'verified' };
    log(
      `${chainNameOf(context)} RPC verified${outcome.warning === undefined ? '' : ` (warning: ${outcome.warning})`}; scanning payments there`,
    );
  }
  return await (deps.catchUp ?? catchUpEip3009)(state, context, now);
}

/** The context whose chain a reported medium names, or `undefined`. */
export function eip3009ContextOf(
  contexts: readonly Eip3009Context[] | undefined,
  medium: string | undefined,
): Eip3009Context | undefined {
  return medium === undefined ? undefined : contexts?.find((context) => context.medium === medium);
}
