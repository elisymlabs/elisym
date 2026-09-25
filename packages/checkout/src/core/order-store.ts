import { ORDER_ACK_TARGET } from './constants';
import {
  type OrderRecord,
  type OrderState,
  type OrderStatus,
  type PaymentMarker,
  holdsPayExclusion,
  isTerminal,
} from './order-record';

const DATABASE_NAME = 'elisym-checkout';
const DATABASE_VERSION = 1;
const ORDERS = 'orders';
const STORES = 'stores';
const BY_PRODUCT = 'productAddress';

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
       * state does not allow this write.
       */
      reason: 'missing' | 'conflict' | 'exclusion' | 'not_ready';
      /** For `exclusion`: the order holding it. */
      holder?: string;
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
    | 'status'
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
  'status',
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
  if (patch.state === 'ordered' && current.state === 'created') {
    const inbox = patch.inboxRelays ?? current.inboxRelays;
    const acknowledged = (patch.acknowledgedRelays ?? current.acknowledgedRelays).filter(
      (relay, index, all) => inbox.includes(relay) && all.indexOf(relay) === index,
    );
    if (
      (patch.orderWrap ?? current.orderWrap) === undefined ||
      inbox.length === 0 ||
      acknowledged.length < Math.min(ORDER_ACK_TARGET, inbox.length)
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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Whether the store has closed the order - cancelled or delivered it. No wallet
 * request, first or retry, is ever made for such an order.
 */
function storeClosed(record: Pick<OrderRecord, 'status'>): boolean {
  return record.status?.status === 'cancelled' || record.status?.status === 'completed';
}

/** The rail a record pays on, from its payout: the marker must be of the same rail. */
function railOf(record: Pick<OrderRecord, 'payout'>): PaymentMarker['rail'] {
  return record.payout.caip19.startsWith('eip155:') ? 'tempo' : 'solana';
}

/**
 * Another record of the same product that holds the pay exclusion, read inside
 * the caller's transaction: every new wallet request (a first attempt or a
 * retry) is atomic with this check.
 */
async function exclusionHolder(
  orders: IDBObjectStore,
  current: OrderRecord,
): Promise<OrderRecord | undefined> {
  const siblings = (await requestResult(
    orders.index(BY_PRODUCT).getAll(current.productAddress),
  )) as OrderRecord[];
  return siblings.find(
    (sibling) => sibling.orderId !== current.orderId && holdsPayExclusion(sibling),
  );
}

/** What a marker proves was requested: a signed transaction, a sent hash or an approved bundle. */
function markerEvidence(marker: PaymentMarker): string[] {
  return marker.rail === 'solana'
    ? [marker.signature ?? '']
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
  return before.every((value, index) => value === '' || value === after[index]);
}

/** Abort a transaction that may already have ended; the caller's own error is what matters. */
function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Already committed or aborted.
  }
}

export function openOrderDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Reading `indexedDB` itself throws where storage is blocked: a refusal, not a crash.
    const request = (factory ?? indexedDB).open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const orders = database.createObjectStore(ORDERS, { keyPath: 'orderId' });
      orders.createIndex(BY_PRODUCT, BY_PRODUCT);
      database.createObjectStore(STORES, { keyPath: 'storePubkey' });
    };
    request.onsuccess = () => {
      const database = request.result;
      // A newer version opened in another tab: step aside rather than block it.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The order database is blocked by another tab'));
  });
}

/**
 * The widget's order records. Every write that decides something about money
 * runs in ONE readwrite transaction with strict durability and re-checks what
 * the caller judged (the record version, the marker's attempt id), so a stale
 * tab or a late wallet answer can never overrun a newer write.
 */
export class OrderStore {
  constructor(private readonly database: IDBDatabase) {}

  private async write(run: (orders: IDBObjectStore) => Promise<StoreWrite>): Promise<StoreWrite> {
    const transaction = this.database.transaction(ORDERS, 'readwrite', { durability: 'strict' });
    const done = transactionDone(transaction);
    let outcome: StoreWrite;
    try {
      outcome = await run(transaction.objectStore(ORDERS));
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => undefined);
      throw error;
    }
    if (!outcome.ok) {
      abortQuietly(transaction);
      await done.catch(() => undefined);
      return outcome;
    }
    // A write that did not commit did not happen: the caller must not open a wallet on it.
    await done;
    return outcome;
  }

  /** Add a new order: `created`, version 1, no marker. Anything else is refused. */
  async add(record: OrderRecord): Promise<void> {
    if (record.state !== 'created' || record.version !== 1 || record.marker !== undefined) {
      throw new Error('A new order record starts as created, at version 1, with no marker');
    }
    const transaction = this.database.transaction(ORDERS, 'readwrite', { durability: 'strict' });
    const done = transactionDone(transaction);
    transaction.objectStore(ORDERS).add(record);
    await done;
  }

  async get(orderId: string): Promise<OrderRecord | undefined> {
    const transaction = this.database.transaction(ORDERS, 'readonly');
    return (await requestResult(transaction.objectStore(ORDERS).get(orderId))) as
      | OrderRecord
      | undefined;
  }

  /** Every record for a product, oldest first. */
  async forProduct(productAddress: string): Promise<OrderRecord[]> {
    const transaction = this.database.transaction(ORDERS, 'readonly');
    const records = (await requestResult(
      transaction.objectStore(ORDERS).index(BY_PRODUCT).getAll(productAddress),
    )) as OrderRecord[];
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Change plain fields of the record the caller judged at `expectedVersion`. */
  update(orderId: string, expectedVersion: number, patch: RecordPatch): Promise<StoreWrite> {
    return this.write(async (orders) => {
      const current = (await requestResult(orders.get(orderId))) as OrderRecord | undefined;
      if (current === undefined) {
        return { ok: false, reason: 'missing' };
      }
      if (current.version !== expectedVersion) {
        return { ok: false, reason: 'conflict' };
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
        return { ok: false, reason: refusal };
      }
      const record: OrderRecord = { ...current, ...defined, version: current.version + 1 };
      await requestResult(orders.put(record));
      return { ok: true, record };
    });
  }

  /**
   * Test-and-set the payment marker immediately before the wallet call. Refused
   * unless the record is still the one judged, acknowledged (`ordered`), holds
   * its composed request and no marker - and no OTHER record for the product
   * holds a live payment (two tabs cannot both pay).
   */
  setMarker(orderId: string, expectedVersion: number, marker: PaymentMarker): Promise<StoreWrite> {
    return this.write(async (orders) => {
      const current = (await requestResult(orders.get(orderId))) as OrderRecord | undefined;
      if (current === undefined) {
        return { ok: false, reason: 'missing' };
      }
      if (current.version !== expectedVersion) {
        return { ok: false, reason: 'conflict' };
      }
      if (
        current.state !== 'ordered' ||
        current.marker !== undefined ||
        current.paymentRequest === undefined ||
        storeClosed(current) ||
        marker.rail !== railOf(current)
      ) {
        return { ok: false, reason: 'not_ready' };
      }
      const holder = await exclusionHolder(orders, current);
      if (holder !== undefined) {
        return { ok: false, reason: 'exclusion', holder: holder.orderId };
      }
      const record: OrderRecord = {
        ...current,
        marker,
        state: 'paying',
        version: current.version + 1,
      };
      await requestResult(orders.put(record));
      return { ok: true, record };
    });
  }

  /**
   * Change the marker of the attempt `attemptId` - record its signature or hash,
   * or replace it with a retry's marker (same record, order and reference). Both
   * the attempt and the record version must be the ones the caller judged: a
   * signature recorded in between is never overrun.
   */
  updateMarker(
    orderId: string,
    expectedVersion: number,
    attemptId: string,
    next: PaymentMarker,
  ): Promise<StoreWrite> {
    return this.write(async (orders) => {
      const current = (await requestResult(orders.get(orderId))) as OrderRecord | undefined;
      if (current === undefined) {
        return { ok: false, reason: 'missing' };
      }
      if (
        current.version !== expectedVersion ||
        current.marker?.attemptId !== attemptId ||
        current.marker.rail !== next.rail
      ) {
        return { ok: false, reason: 'conflict' };
      }
      if (current.state !== 'paying') {
        return { ok: false, reason: 'not_ready' };
      }
      const retry = next.attemptId !== attemptId;
      // Tempo has no in-widget retry (an old prompt would pay too); within one
      // attempt, what the marker proves is never dropped or changed.
      // Within one attempt its pay window is fixed too: the expiry wait (Solana) and
      // the reconciliation floor (Tempo) are measured against what was stored.
      const windowMoved =
        current.marker.rail === 'solana' && next.rail === 'solana'
          ? next.blockhash !== current.marker.blockhash ||
            next.lastValidBlockHeight !== current.marker.lastValidBlockHeight
          : current.marker.rail === 'tempo' &&
            next.rail === 'tempo' &&
            next.floorBlock !== current.marker.floorBlock;
      if (
        (retry && next.rail === 'tempo') ||
        (!retry && !keepsEvidence(current.marker, next)) ||
        (!retry && windowMoved)
      ) {
        return { ok: false, reason: 'not_ready' };
      }
      // A retry is a new wallet request: never for an order the store cancelled,
      // and the product must still be free of any other order holding the
      // exclusion (one paid late meanwhile, say).
      if (retry && storeClosed(current)) {
        return { ok: false, reason: 'not_ready' };
      }
      if (retry) {
        const holder = await exclusionHolder(orders, current);
        if (holder !== undefined) {
          return { ok: false, reason: 'exclusion', holder: holder.orderId };
        }
      }
      const record: OrderRecord = { ...current, marker: next, version: current.version + 1 };
      await requestResult(orders.put(record));
      return { ok: true, record };
    });
  }

  /**
   * End the attempt `attemptId`, judged at `expectedVersion`: nothing was
   * requested (`ordered`, the marker is removed), or the attempt provably ended
   * (`ended-unpaid`, the marker is KEPT - it no longer excludes, but its floor,
   * signature or hash is what later reconciliation starts from).
   */
  clearMarker(
    orderId: string,
    expectedVersion: number,
    attemptId: string,
    nextState: Extract<OrderState, 'ordered' | 'ended-unpaid'>,
  ): Promise<StoreWrite> {
    return this.write(async (orders) => {
      const current = (await requestResult(orders.get(orderId))) as OrderRecord | undefined;
      if (current === undefined) {
        return { ok: false, reason: 'missing' };
      }
      if (current.version !== expectedVersion || current.marker?.attemptId !== attemptId) {
        return { ok: false, reason: 'conflict' };
      }
      if (current.state !== 'paying') {
        return { ok: false, reason: 'not_ready' };
      }
      let record: OrderRecord;
      // An approved Tempo bundle may still land under a new hash: it never ends
      // unpaid on a deadline, it stays live until it is found.
      if (
        nextState === 'ended-unpaid' &&
        current.marker?.rail === 'tempo' &&
        current.marker.bundleId !== undefined
      ) {
        return { ok: false, reason: 'not_ready' };
      }
      // "Nothing was requested" is false once the marker proves a request.
      if (
        nextState === 'ordered' &&
        current.marker !== undefined &&
        holdsEvidence(current.marker)
      ) {
        return { ok: false, reason: 'not_ready' };
      }
      if (nextState === 'ordered') {
        const { marker: _removed, ...rest } = current;
        record = { ...rest, state: nextState, version: current.version + 1 };
      } else {
        record = { ...current, state: nextState, version: current.version + 1 };
      }
      await requestResult(orders.put(record));
      return { ok: true, record };
    });
  }

  async pins(storePubkey: string): Promise<StorePinsRecord | undefined> {
    const transaction = this.database.transaction(STORES, 'readonly');
    return (await requestResult(transaction.objectStore(STORES).get(storePubkey))) as
      | StorePinsRecord
      | undefined;
  }

  /**
   * After a delivery: pin the store's owner, and add every payout of the offer
   * that delivered to the known ones (pinning only the paid one would flag every
   * other rail the store lists as changed next time). A delivery under a
   * different owner than the pinned one never replaces the pin here.
   */
  async rememberDelivery(
    storePubkey: string,
    ownerPubkey: string,
    payouts: readonly { caip19: string; address: string }[],
  ): Promise<StorePinsRecord> {
    const transaction = this.database.transaction(STORES, 'readwrite', { durability: 'strict' });
    const done = transactionDone(transaction);
    const stores = transaction.objectStore(STORES);
    // `done` settles with the transaction; the request that failed is the error to report.
    done.catch(() => undefined);
    const current = (await requestResult(stores.get(storePubkey))) as StorePinsRecord | undefined;
    if (current !== undefined && current.pinnedOwnerPubkey !== ownerPubkey) {
      abortQuietly(transaction);
      await done.catch(() => undefined);
      return current;
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
    await requestResult(stores.put(record));
    await done;
    return record;
  }
}
