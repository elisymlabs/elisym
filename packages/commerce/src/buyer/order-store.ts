import { MAX_CLOCK_SKEW_SECS, MERCHANT_CATCH_UP_SECS, ORDER_ACK_TARGET } from './constants';
import { isGenuineEvent } from './events';
import {
  type EndedBy,
  type OrderRecord,
  type OrderState,
  type OrderStatus,
  type PaymentMarker,
  holdsPayExclusion,
  isTerminal,
} from './order-record';
import { relayHost } from './relays';

/** Per store, what earlier purchases pinned (TOFU). */
export interface StorePinsRecord {
  storePubkey: string;
  pinnedOwnerPubkey: string;
  /** The union of every payout of every verified offer that delivered from this store. */
  knownPayouts: { caip19: string; address: string }[];
}

export type StoreWrite =
  | { ok: true; record: OrderRecord }
  | {
      ok: false;
      /**
       * `missing`: no such record. `conflict`: the record (its version or its
       * marker's attempt) is not the one the caller judged. `exclusion`: another
       * record for this product holds a live payment. `not_ready`: the record's
       * state does not allow this write. `needs_confirmation`: a Tempo order of
       * this product ended `over` - its wallet prompt may still be approved - and
       * the buyer has not confirmed the warning for it on this record.
       */
      reason: 'missing' | 'conflict' | 'exclusion' | 'not_ready' | 'needs_confirmation';
      /** For `exclusion`: the order holding it. */
      holder?: string;
      /** For `needs_confirmation`: the ended orders to confirm. */
      unconfirmed?: string[];
    };

/**
 * Fields a plain update may change. What the order and its payment were made of
 * (payout, amount, reference, offer, ...) is fixed when the record is added; the
 * marker and the version have their own paths.
 */
export type RecordPatch = Partial<
  Pick<
    OrderRecord,
    | 'state'
    | 'paymentRequest'
    | 'orderWrap'
    | 'receiptWrap'
    | 'inboxRelays'
    | 'acknowledgedRelays'
    | 'paidTx'
    | 'paidAt'
    | 'status'
    | 'endedBy'
    | 'confirmedOverIds'
  >
>;

/** The keys of `RecordPatch`, enforced at runtime too: a spread record carries more. */
const PATCH_KEYS = [
  'state',
  'paymentRequest',
  'orderWrap',
  'receiptWrap',
  'inboxRelays',
  'acknowledgedRelays',
  'paidTx',
  'paidAt',
  'status',
  'endedBy',
  'confirmedOverIds',
] as const satisfies readonly (keyof RecordPatch)[];

/** The statuses that may follow a stored one: a store's answer only moves forward. */
const STATUS_SUCCESSORS: Record<OrderStatus['status'], readonly OrderStatus['status'][]> = {
  pending: ['pending', 'confirmed', 'completed', 'cancelled'],
  confirmed: ['confirmed', 'completed', 'cancelled'],
  cancelled: ['cancelled', 'completed'],
  completed: ['completed'],
};

/** The states a found payment (`paidTx`) may be recorded with. */
const PAID_STATES: readonly OrderState[] = ['paid', 'completed', 'refunded'];

/**
 * The states a plain update may move a record to. Only forward: an ended order
 * is never reopened (a new order starts instead), a terminal record never
 * changes, `paying` is entered only by `setMarker` and left for `ordered` or
 * `ended-unpaid` only by `clearMarker`.
 */
const NEXT_STATES: Record<OrderState, readonly OrderState[]> = {
  created: ['ordered'],
  ordered: ['paid', 'completed', 'refunded', 'ended-unpaid'],
  paying: ['paid', 'completed', 'refunded', 'blocked'],
  paid: ['completed', 'refunded'],
  'ended-unpaid': ['paid', 'completed', 'refunded', 'blocked'],
  blocked: ['paid', 'completed', 'refunded'],
  completed: [],
  refunded: [],
};

/** Why a plain patch may not apply to `current`, or `undefined` when it may. */
function patchRefusal(current: OrderRecord, patch: RecordPatch): 'not_ready' | undefined {
  if (isTerminal(current)) {
    return 'not_ready';
  }
  if (
    patch.state !== undefined &&
    patch.state !== current.state &&
    !NEXT_STATES[current.state].includes(patch.state)
  ) {
    return 'not_ready';
  }
  // Written once, before the first marker: resume and every verdict use this request.
  const nextState = patch.state ?? current.state;
  if (
    patch.paymentRequest !== undefined &&
    (current.paymentRequest !== undefined || nextState !== 'ordered')
  ) {
    return 'not_ready';
  }
  // Only a Tempo payment can sit with a transfer-policy guard.
  if (
    patch.state === 'blocked' &&
    current.state !== 'blocked' &&
    !current.payout.caip19.startsWith('eip155:')
  ) {
    return 'not_ready';
  }
  // The transaction that paid is written once, together with the state it
  // means: a record whose payment was found is never left open to pay again, and
  // a second payment found later is reconciled by hand, never erasing the first.
  if (
    patch.paidTx !== undefined &&
    (current.paidTx !== undefined || !PAID_STATES.includes(nextState))
  ) {
    return 'not_ready';
  }
  if (patch.paidAt !== undefined && patch.paidTx === undefined) {
    return 'not_ready';
  }
  // Why a Tempo record ended is written with the move to `ended-unpaid` and never
  // changed; a plain update ends only an order nothing was requested for.
  const tempo = railOf(current) === 'tempo';
  const endsUnpaid = patch.state === 'ended-unpaid' && current.state !== 'ended-unpaid';
  if (patch.endedBy !== undefined && (!tempo || !endsUnpaid || patch.endedBy !== 'nothing')) {
    return 'not_ready';
  }
  if (tempo && endsUnpaid && patch.endedBy === undefined) {
    return 'not_ready';
  }
  // Confirmations only accumulate.
  if (
    patch.confirmedOverIds !== undefined &&
    !(current.confirmedOverIds ?? []).every((id) => patch.confirmedOverIds?.includes(id))
  ) {
    return 'not_ready';
  }
  // The receipt is republished byte for byte; only a Solana retry (still paying,
  // nothing found yet) sends a new one, for its own transaction.
  if (
    patch.receiptWrap !== undefined &&
    current.receiptWrap !== undefined &&
    current.state !== 'paying'
  ) {
    return 'not_ready';
  }
  // A store's answer never goes back: relays return old status wraps in any
  // order, and a stale `pending` must not reopen a cancelled order for paying.
  // Once `completed` is seen it is kept; after `cancelled` only a delivery or a
  // repeated cancellation (a refund) may follow.
  if (patch.status !== undefined && current.status !== undefined) {
    const allowed = STATUS_SUCCESSORS[current.status.status];
    if (!allowed.includes(patch.status.status)) {
      return 'not_ready';
    }
    // A refund, once seen, is kept: a stale cancellation without one never erases it.
    if (current.status.refunded === true && patch.status.refunded !== true) {
      return 'not_ready';
    }
  }
  // Acknowledged means the store's inbox holds the signed order - two of its
  // relays said OK (one when it lists one): the wallet may open only after that.
  // Counted per relay SERVER (host and port): two URLs of one relay are one.
  if (patch.state === 'ordered' && current.state === 'created') {
    const inbox = patch.inboxRelays ?? current.inboxRelays;
    const inboxHosts = new Set(inbox.map(relayHost));
    const acknowledgedHosts = new Set(
      (patch.acknowledgedRelays ?? current.acknowledgedRelays)
        .filter((relay) => inbox.includes(relay))
        .map(relayHost),
    );
    const wrap = patch.orderWrap ?? current.orderWrap;
    if (
      wrap === undefined ||
      !isGenuineEvent(wrap) ||
      inboxHosts.size === 0 ||
      acknowledgedHosts.size < Math.min(ORDER_ACK_TARGET, inboxHosts.size)
    ) {
      return 'not_ready';
    }
  }
  // Republished byte for byte on resume: the same rumor, never a new one.
  if (patch.orderWrap !== undefined && current.orderWrap !== undefined) {
    return 'not_ready';
  }
  return undefined;
}

/**
 * Whether the store has closed the order - cancelled or delivered it. No wallet
 * request, first or retry, is ever made for such an order.
 */
export function storeClosed(record: Pick<OrderRecord, 'status'>): boolean {
  return record.status?.status === 'cancelled' || record.status?.status === 'completed';
}

/** The rail a record pays on, from its payout: the marker must be of the same rail. */
function railOf(record: Pick<OrderRecord, 'payout'>): PaymentMarker['rail'] {
  return record.payout.caip19.startsWith('eip155:') ? 'tempo' : 'solana';
}

/** What a marker proves was requested: a signed transaction, a sent hash or an approved bundle. */
function markerEvidence(marker: PaymentMarker): string[] {
  return marker.rail === 'solana'
    ? [marker.signature ?? '', marker.signedTransaction ?? '']
    : [marker.txHash ?? '', marker.bundleId ?? ''];
}

function holdsEvidence(marker: PaymentMarker): boolean {
  return markerEvidence(marker).some((value) => value !== '');
}

/**
 * Whether `next` keeps everything `current` proves: evidence is only ever added
 * (a retry replaces an expired Solana attempt; its old signature is checked
 * before the retry is allowed).
 */
function keepsEvidence(current: PaymentMarker, next: PaymentMarker): boolean {
  const before = markerEvidence(current);
  const after = markerEvidence(next);
  // A failed bundle stays failed: the wallet's final word is never taken back.
  const failedKept =
    current.rail !== 'tempo' ||
    current.bundleFailed !== true ||
    (next.rail === 'tempo' && next.bundleFailed === true);
  return failedKept && before.every((value, index) => value === '' || value === after[index]);
}

/**
 * Whether `next` marks a bundle failed that `current` did not: only for a
 * marker that holds a bundle and no hash (a hash is evidence of its own, and
 * the wallet's word on a bundle says nothing about it).
 */
function failsBundle(current: PaymentMarker, next: PaymentMarker): 'ok' | 'refused' | 'none' {
  if (next.rail !== 'tempo' || next.bundleFailed !== true) {
    return 'none';
  }
  if (current.rail === 'tempo' && current.bundleFailed === true) {
    return 'none';
  }
  return current.rail === 'tempo' &&
    current.bundleId !== undefined &&
    current.txHash === undefined &&
    next.txHash === undefined
    ? 'ok'
    : 'refused';
}

/**
 * A Tempo marker whose only evidence is a bundle the wallet reported failed:
 * it may still end `over` (and only that).
 */
function onlyFailedBundle(marker: PaymentMarker): boolean {
  return marker.rail === 'tempo' && marker.bundleFailed === true && marker.txHash === undefined;
}

/**
 * Where order records live. Every money rule is judged by the core (below) on
 * what `transactProduct` hands it; a backend only makes that read-judge-write
 * atomic and durable: the checkout's IndexedDB (one readwrite transaction with
 * strict durability), the MCP's locked, fsynced file, or memory in tests.
 *
 * `fn` is synchronous: the rule runs between the read and the write of ONE
 * transaction (an `await` inside would let IndexedDB commit part-way). A
 * backend resolves only once the writes are committed; a write that did not
 * commit did not happen, and nothing is decided on it.
 */
export interface OrderBackend {
  read(orderId: string): Promise<OrderRecord | undefined>;
  /** Every record for a product (any order; the store sorts). */
  forProduct(productAddress: string): Promise<OrderRecord[]>;
  /** Read the product's records, run `fn`, commit its writes (whole records, by `orderId`). */
  transactProduct<T>(
    productAddress: string,
    fn: (records: readonly OrderRecord[]) => { write?: readonly OrderRecord[]; result: T },
  ): Promise<T>;
  readPins(storePubkey: string): Promise<StorePinsRecord | undefined>;
  /** Read one store's pins, run `fn`, commit its write. */
  transactPins<T>(
    storePubkey: string,
    fn: (pins: StorePinsRecord | undefined) => { write?: StorePinsRecord; result: T },
  ): Promise<T>;
}

/** A rule's verdict: what the caller is told, and the record to write when it is `ok`. */
interface Judged {
  result: StoreWrite;
  write?: readonly OrderRecord[];
}

function refused(reason: Extract<StoreWrite, { ok: false }>['reason'], holder?: string): Judged {
  return { result: holder === undefined ? { ok: false, reason } : { ok: false, reason, holder } };
}

function accepted(record: OrderRecord): Judged {
  return { result: { ok: true, record }, write: [record] };
}

/**
 * Another record of the same product that holds the pay exclusion, judged in the
 * same transaction as the write: every new wallet request (a first attempt or a
 * retry) is atomic with this check.
 */
function exclusionHolder(
  records: readonly OrderRecord[],
  current: OrderRecord,
): OrderRecord | undefined {
  return records.find(
    (sibling) => sibling.orderId !== current.orderId && holdsPayExclusion(sibling),
  );
}

/** The judged record, or a refusal when it is gone or is not the version judged. */
function judgedRecord(
  records: readonly OrderRecord[],
  orderId: string,
  expectedVersion: number,
): OrderRecord | Judged {
  const current = records.find((record) => record.orderId === orderId);
  if (current === undefined) {
    return refused('missing');
  }
  if (current.version !== expectedVersion) {
    return refused('conflict');
  }
  return current;
}

function isJudged(value: OrderRecord | Judged): value is Judged {
  return 'result' in value;
}

/** A new order: `created`, version 1, no marker, an id not yet used. */
export function judgeAdd(records: readonly OrderRecord[], record: OrderRecord): Judged {
  if (record.state !== 'created' || record.version !== 1 || record.marker !== undefined) {
    throw new Error('A new order record starts as created, at version 1, with no marker');
  }
  if (records.some((existing) => existing.orderId === record.orderId)) {
    throw new Error('An order record with this id already exists');
  }
  return { result: { ok: true, record }, write: [record] };
}

/** Plain fields of the record the caller judged at `expectedVersion`. */
export function judgeUpdate(
  records: readonly OrderRecord[],
  orderId: string,
  expectedVersion: number,
  patch: RecordPatch,
): Judged {
  const current = judgedRecord(records, orderId, expectedVersion);
  if (isJudged(current)) {
    return current;
  }
  // Only the patchable keys, and only those set: a key set to `undefined` would
  // wipe the field on spread, and any other key is not a plain update's to change.
  const defined: RecordPatch = {};
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) {
      Object.assign(defined, { [key]: patch[key] });
    }
  }
  const refusal = patchRefusal(current, defined);
  if (refusal !== undefined) {
    return refused(refusal);
  }
  return accepted({ ...current, ...defined, version: current.version + 1 });
}

/**
 * Tempo orders of this product that ended `over` (or with no reason, fail
 * closed) inside the merchant's catch-up and that `current` has not confirmed:
 * their wallet prompt may still be approved, so a new wallet request for
 * another order needs the buyer's explicit confirmation first. Without `now`
 * every such order counts as recent.
 */
function unconfirmedOver(
  records: readonly OrderRecord[],
  current: OrderRecord,
  now: number | undefined,
): string[] {
  return records
    .filter(
      (sibling) =>
        sibling.orderId !== current.orderId &&
        railOf(sibling) === 'tempo' &&
        sibling.state === 'ended-unpaid' &&
        (sibling.endedBy === 'over' || sibling.endedBy === undefined) &&
        (now === undefined ||
          now - sibling.createdAt <= MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS) &&
        !(current.confirmedOverIds ?? []).includes(sibling.orderId),
    )
    .map((sibling) => sibling.orderId);
}

function needsConfirmation(unconfirmed: string[]): Judged {
  return { result: { ok: false, reason: 'needs_confirmation', unconfirmed } };
}

/**
 * Test-and-set the payment marker immediately before the wallet call. Refused
 * unless the record is still the one judged, acknowledged (`ordered`), holds
 * its composed request and no marker - and no OTHER record for the product
 * holds a live payment (two tabs cannot both pay).
 */
export function judgeSetMarker(
  records: readonly OrderRecord[],
  orderId: string,
  expectedVersion: number,
  marker: PaymentMarker,
  now?: number,
): Judged {
  const current = judgedRecord(records, orderId, expectedVersion);
  if (isJudged(current)) {
    return current;
  }
  if (
    current.state !== 'ordered' ||
    current.marker !== undefined ||
    current.paymentRequest === undefined ||
    storeClosed(current) ||
    marker.rail !== railOf(current)
  ) {
    return refused('not_ready');
  }
  const holder = exclusionHolder(records, current);
  if (holder !== undefined) {
    return refused('exclusion', holder.orderId);
  }
  const unconfirmed = unconfirmedOver(records, current, now);
  if (unconfirmed.length > 0) {
    return needsConfirmation(unconfirmed);
  }
  return accepted({ ...current, marker, state: 'paying', version: current.version + 1 });
}

/**
 * Change the marker of the attempt `attemptId` - record its signature or hash,
 * or replace it with a retry's marker (same record, order and reference). Both
 * the attempt and the record version must be the ones the caller judged: a
 * signature recorded in between is never overrun.
 */
export function judgeUpdateMarker(
  records: readonly OrderRecord[],
  orderId: string,
  expectedVersion: number,
  attemptId: string,
  next: PaymentMarker,
  now?: number,
): Judged {
  const current = records.find((record) => record.orderId === orderId);
  if (current === undefined) {
    return refused('missing');
  }
  if (
    current.version !== expectedVersion ||
    current.marker?.attemptId !== attemptId ||
    current.marker.rail !== next.rail
  ) {
    return refused('conflict');
  }
  if (current.state !== 'paying') {
    return refused('not_ready');
  }
  const retry = next.attemptId !== attemptId;
  // Tempo has no in-widget retry (an old prompt would pay too); within one
  // attempt, what the marker proves is never dropped or changed.
  // Within one attempt its pay window is fixed too: the expiry wait (Solana) and
  // the reconciliation floor (Tempo) are measured against what was stored.
  const windowMoved =
    current.marker.rail === 'solana' && next.rail === 'solana'
      ? next.blockhash !== current.marker.blockhash ||
        next.lastValidBlockHeight !== current.marker.lastValidBlockHeight ||
        next.slot !== current.marker.slot
      : current.marker.rail === 'tempo' &&
        next.rail === 'tempo' &&
        next.floorBlock !== current.marker.floorBlock;
  if (
    (retry && next.rail === 'tempo') ||
    (!retry && !keepsEvidence(current.marker, next)) ||
    (!retry && windowMoved) ||
    failsBundle(current.marker, next) === 'refused'
  ) {
    return refused('not_ready');
  }
  // A retry is a new wallet request: never for an order the store cancelled,
  // and the product must still be free of any other order holding the
  // exclusion (one paid late meanwhile, say).
  if (retry && storeClosed(current)) {
    return refused('not_ready');
  }
  if (retry) {
    const holder = exclusionHolder(records, current);
    if (holder !== undefined) {
      return refused('exclusion', holder.orderId);
    }
    const unconfirmed = unconfirmedOver(records, current, now);
    if (unconfirmed.length > 0) {
      return needsConfirmation(unconfirmed);
    }
  }
  return accepted({ ...current, marker: next, version: current.version + 1 });
}

/**
 * End the attempt `attemptId`, judged at `expectedVersion`: nothing was
 * requested (`ordered`, the marker is removed), or the attempt provably ended
 * (`ended-unpaid`, the marker is KEPT - it no longer excludes, but its floor,
 * signature or hash is what later reconciliation starts from).
 */
export function judgeClearMarker(
  records: readonly OrderRecord[],
  orderId: string,
  expectedVersion: number,
  attemptId: string,
  nextState: Extract<OrderState, 'ordered' | 'ended-unpaid'>,
  endedBy?: Exclude<EndedBy, 'nothing'>,
): Judged {
  const current = records.find((record) => record.orderId === orderId);
  if (current === undefined) {
    return refused('missing');
  }
  if (current.version !== expectedVersion || current.marker?.attemptId !== attemptId) {
    return refused('conflict');
  }
  if (current.state !== 'paying') {
    return refused('not_ready');
  }
  // A Tempo attempt that holds a sent hash or an approved bundle may still land
  // (under a new hash, through a relayer): it never ends unpaid, it stays live
  // until it is found. One that ends says why, once: a proving rejection (nothing
  // signed) or `over` (proven unpaid, its prompt still open). The one release: a
  // bundle the wallet reported failed, with no hash, may end `over`.
  const tempo = current.marker?.rail === 'tempo';
  if (nextState === 'ended-unpaid' && tempo) {
    if (
      current.marker !== undefined &&
      holdsEvidence(current.marker) &&
      !(onlyFailedBundle(current.marker) && endedBy === 'over')
    ) {
      return refused('not_ready');
    }
    if (endedBy === undefined) {
      return refused('not_ready');
    }
  }
  if (endedBy !== undefined && (!tempo || nextState !== 'ended-unpaid')) {
    return refused('not_ready');
  }
  // "Nothing was requested" is false once the marker proves a request.
  if (nextState === 'ordered' && current.marker !== undefined && holdsEvidence(current.marker)) {
    return refused('not_ready');
  }
  if (nextState === 'ordered') {
    const { marker: _removed, ...rest } = current;
    return accepted({ ...rest, state: nextState, version: current.version + 1 });
  }
  return accepted({
    ...current,
    state: nextState,
    ...(endedBy === undefined ? {} : { endedBy }),
    version: current.version + 1,
  });
}

/**
 * After a delivery: pin the store's owner, and add every payout of the offer
 * that delivered to the known ones (pinning only the paid one would flag every
 * other rail the store lists as changed next time). A delivery under a
 * different owner than the pinned one never replaces the pin.
 */
export function mergePins(
  current: StorePinsRecord | undefined,
  storePubkey: string,
  ownerPubkey: string,
  payouts: readonly { caip19: string; address: string }[],
): { write?: StorePinsRecord; result: StorePinsRecord } {
  if (current !== undefined && current.pinnedOwnerPubkey !== ownerPubkey) {
    return { result: current };
  }
  const known = [...(current?.knownPayouts ?? [])];
  for (const payout of payouts) {
    if (
      !known.some((entry) => entry.caip19 === payout.caip19 && entry.address === payout.address)
    ) {
      known.push({ caip19: payout.caip19, address: payout.address });
    }
  }
  const record: StorePinsRecord = {
    storePubkey,
    pinnedOwnerPubkey: ownerPubkey,
    knownPayouts: known,
  };
  return { write: record, result: record };
}

/**
 * The order records, over any `OrderBackend`. Every write that decides
 * something about money is judged inside the backend's transaction and
 * re-checks what the caller judged (the record version, the marker's attempt
 * id), so a stale tab, a second process or a late wallet answer can never
 * overrun a newer write.
 */
export class OrderStore {
  constructor(private readonly backend: OrderBackend) {}

  /** Add a new order: `created`, version 1, no marker. Anything else is refused. */
  async add(record: OrderRecord): Promise<void> {
    await this.backend.transactProduct(record.productAddress, (records) =>
      judgeAdd(records, record),
    );
  }

  get(orderId: string): Promise<OrderRecord | undefined> {
    return this.backend.read(orderId);
  }

  /** Every record for a product, oldest first. */
  async forProduct(productAddress: string): Promise<OrderRecord[]> {
    const records = await this.backend.forProduct(productAddress);
    return [...records].sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Run a rule on the product of `orderId` (it never changes), in one transaction. */
  private async judge(
    orderId: string,
    rule: (records: readonly OrderRecord[]) => Judged,
  ): Promise<StoreWrite> {
    const known = await this.backend.read(orderId);
    if (known === undefined) {
      return { ok: false, reason: 'missing' };
    }
    return this.backend.transactProduct(known.productAddress, rule);
  }

  /** Change plain fields of the record the caller judged at `expectedVersion`. */
  update(orderId: string, expectedVersion: number, patch: RecordPatch): Promise<StoreWrite> {
    return this.judge(orderId, (records) => judgeUpdate(records, orderId, expectedVersion, patch));
  }

  /** See `judgeSetMarker`. */
  setMarker(
    orderId: string,
    expectedVersion: number,
    marker: PaymentMarker,
    now?: number,
  ): Promise<StoreWrite> {
    return this.judge(orderId, (records) =>
      judgeSetMarker(records, orderId, expectedVersion, marker, now),
    );
  }

  /** See `judgeUpdateMarker`. */
  updateMarker(
    orderId: string,
    expectedVersion: number,
    attemptId: string,
    next: PaymentMarker,
    now?: number,
  ): Promise<StoreWrite> {
    return this.judge(orderId, (records) =>
      judgeUpdateMarker(records, orderId, expectedVersion, attemptId, next, now),
    );
  }

  /** See `judgeClearMarker`. */
  clearMarker(
    orderId: string,
    expectedVersion: number,
    attemptId: string,
    nextState: Extract<OrderState, 'ordered' | 'ended-unpaid'>,
    endedBy?: Exclude<EndedBy, 'nothing'>,
  ): Promise<StoreWrite> {
    return this.judge(orderId, (records) =>
      judgeClearMarker(records, orderId, expectedVersion, attemptId, nextState, endedBy),
    );
  }

  pins(storePubkey: string): Promise<StorePinsRecord | undefined> {
    return this.backend.readPins(storePubkey);
  }

  /** See `mergePins`. */
  rememberDelivery(
    storePubkey: string,
    ownerPubkey: string,
    payouts: readonly { caip19: string; address: string }[],
  ): Promise<StorePinsRecord> {
    return this.backend.transactPins(storePubkey, (current) =>
      mergePins(current, storePubkey, ownerPubkey, payouts),
    );
  }
}

/**
 * An in-memory backend: for tests, and for a caller that keeps orders only for
 * the life of the process. Transactions on it are trivially atomic (one thread).
 */
export class MemoryOrderBackend implements OrderBackend {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly stores = new Map<string, StorePinsRecord>();

  async read(orderId: string): Promise<OrderRecord | undefined> {
    return structuredClone(this.orders.get(orderId));
  }

  private snapshot(productAddress: string): OrderRecord[] {
    return [...this.orders.values()]
      .filter((record) => record.productAddress === productAddress)
      .map((record) => structuredClone(record));
  }

  async forProduct(productAddress: string): Promise<OrderRecord[]> {
    return this.snapshot(productAddress);
  }

  // Read, rule and write run with no await between them: no other call can interleave.
  async transactProduct<T>(
    productAddress: string,
    fn: (records: readonly OrderRecord[]) => { write?: readonly OrderRecord[]; result: T },
  ): Promise<T> {
    const { write, result } = fn(this.snapshot(productAddress));
    for (const record of write ?? []) {
      this.orders.set(record.orderId, structuredClone(record));
    }
    return result;
  }

  async readPins(storePubkey: string): Promise<StorePinsRecord | undefined> {
    return structuredClone(this.stores.get(storePubkey));
  }

  async transactPins<T>(
    storePubkey: string,
    fn: (pins: StorePinsRecord | undefined) => { write?: StorePinsRecord; result: T },
  ): Promise<T> {
    const { write, result } = fn(structuredClone(this.stores.get(storePubkey)));
    if (write !== undefined) {
      this.stores.set(storePubkey, structuredClone(write));
    }
    return result;
  }
}
