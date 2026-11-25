/**
 * The required-relay mirror sweep (phase 4 step 2b): every hosted store's
 * newest events must reach the required relay (`PAYCORE_REQUIRED_RELAY`,
 * one of the offer relays), the one relay every reader of the store is sure
 * to ask. Every `MIRROR_SWEEP_SECS`, for every store with an S (any status,
 * suspended included, so a winding-down store's sold-out listings still
 * arrive; a deleted store has no row and is no longer swept):
 *
 * 1. Claim the store for this period (`mirror_swept_at`): one instance sweeps
 *    it per period, whichever claims first.
 * 2. Read the newest store events on the default relays and on the required
 *    relay alone: S's profile (0), inbox list (10050) and every listing
 *    (30402) whose `d` the store's products or ledger name (chunked `#d`
 *    reads, never an unfiltered author query); O's payout list (10133) and
 *    the store authorization (30490, `d` = S); the deletions (kind 5) by O
 *    naming `30490:O:S` or `10133:O:` and by S naming its listings. The
 *    required relay counts only when every read of it finished with its EOSE;
 *    a timeout or a closed subscription skips the store this round.
 * 3. On both sides an event counts only with a valid signature by the
 *    expected author, checked before the newest is picked (commerce
 *    `newestSigned`): a forged "newer" entry cannot hide the genuine one.
 * 4. Deletions first: one the default relays serve and the required relay
 *    lacks (none as new there for that address) is copied. Then each address
 *    whose newest event the required relay lacks (absent, or older) is copied,
 *    unless it is covered: the newest deletion of that address by the same
 *    author (either side) is dated at or after it. A 10133 is never covered
 *    (the checkout applies no deletion to it); its deletion is still mirrored.
 *    Of two events in the same second the lowest id is the newest, as readers pick.
 * 5. Each copy is the exact signed event, sent to the required relay only,
 *    authenticated (NIP-42) as S through the vault. At most
 *    `MIRROR_SEND_CAP` sends per store per sweep; a refusal is logged and
 *    tried again next period, never within this one.
 *
 * A store that moved to a new owner key: until its latest move switched,
 * buyers still anchor on the former owner, so the former owner's payout
 * list, authorization and their deletions are swept as the owner's are;
 * after the switch, only the former owners' authorizations at S (their
 * revocations) are.
 *
 * `stop` claims no further store and abandons the one in progress at once
 * (its claim stands: that store waits for the next period).
 *
 * Nothing is signed here and nothing but `mirror_swept_at` is stored.
 */
import {
  KIND_DELETION,
  KIND_INBOX_RELAYS,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_AUTH,
  KIND_STORE_PROFILE,
  NO_FUTURE_LIMIT,
  newestDeletion,
  newestSigned,
  productAddress,
  storeAuthAddress,
} from '@elisym/commerce';
import type { QueryPool } from '@merchant-node/checks';
import { OFFER_RELAYS, PUBLISH_DEADLINE_MS } from '@merchant-node/constants';
import { readListingChunks } from '@merchant-node/listing-reads';
import {
  type AuthSigner,
  type PublishPool,
  type PublishRelay,
  publishToRelays,
} from '@merchant-node/publish';
import { storeAuth } from '@merchant-node/store-node';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { Db } from '../db/db';
import type { KeyVault } from '../db/keys';
import { parseLedger } from '../state/ledger-store';
import { storeMoves } from '../state/move-rows';

/** How long a store waits between two sweeps. */
export const MIRROR_SWEEP_SECS = 15 * 60;
/** How often the server looks for stores whose sweep is due. */
export const MIRROR_TICK_MS = 60_000;
/** How many events one store's sweep sends at most. */
export const MIRROR_SEND_CAP = 50;
/** How many due stores one tick takes at most (the rest wait for the next tick). */
export const MIRROR_STORES_PER_TICK = 100;
/** How long one read may take before it counts as not read. */
export const MIRROR_READ_TIMEOUT_MS = 10_000;

export interface MirrorSubscribeParams {
  onevent: (event: NostrEvent) => void;
  oneose: () => void;
  onclose: (reason: string) => void;
  /** nostr-tools fires `oneose` itself at this deadline: set past the sweep's own timeout. */
  eoseTimeout: number;
}

/** The part of a connected nostr-tools relay the sweep reads and writes the required relay with. */
export interface MirrorRelay extends PublishRelay {
  subscribe(filters: Filter[], params: MirrorSubscribeParams): { close: () => void };
}

/** A pool for one store's sweep, destroyed after it (its connections authenticate as that S). */
export interface MirrorPool extends QueryPool, PublishPool {
  ensureRelay(url: string): Promise<MirrorRelay>;
  destroy(): void;
}

export interface MirrorSweeperDeps {
  db: Db;
  vault: KeyVault;
  makePool: () => MirrorPool;
  requiredRelay: string;
  /** Default: merchant-node's `OFFER_RELAYS`. */
  defaultRelays?: readonly string[];
  log?: (message: string) => void;
  /** Seconds. */
  now: () => number;
  readTimeoutMs?: number;
  /** A send's deadline (merchant-node's default when absent). */
  deadlineMs?: number;
}

/** What one store's sweep did. */
export type StoreSweep =
  | { owner: string; outcome: 'skipped'; reason: string }
  | { owner: string; outcome: 'swept'; sent: number; refused: number };

interface DueStore extends Record<string, unknown> {
  owner: string;
  store_pubkey: string;
  store_key: Uint8Array;
}

/** One address a store's readers resolve, and the deletion address that can cover it. */
export interface MirrorAddress {
  kind: number;
  author: string;
  d?: string;
  /** The NIP-09 address whose deletions are mirrored. */
  deletion?: string;
  /** Whether such a deletion hides the event from readers (so it is then not copied). */
  deletionCovers?: boolean;
}

/** The required relay did not finish a read (no EOSE in time, or the subscription was closed). */
class RequiredNotRead extends Error {}

/** `stop` was asked: the sweep in progress gives up at its next read or send. */
class SweepStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'SweepStopped';
  }
}

/** `work`, or `SweepStopped` as soon as `signal` aborts (the work itself is left to finish or be torn down). */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SweepStopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SweepStopped());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** NIP-09 names a replaceable event by `<kind>:<pubkey>:` (an empty `d`). */
export function payoutListAddress(owner: string): string {
  return `${KIND_PAYTO}:${owner}:`;
}

/** The store's listing ids: its products and every listing its ledger ever published (retired and sold-out too). */
async function listingDs(db: Db, owner: string, signal: AbortSignal): Promise<string[]> {
  const products = await db.query<{ d: string }>('select d from products where owner = $1', [
    owner,
  ]);
  if (signal.aborted) {
    throw new SweepStopped();
  }
  const [ledger] = await db.query<{ state: string }>('select state from ledgers where owner = $1', [
    owner,
  ]);
  const listings: unknown =
    ledger === undefined ? undefined : parseLedger(ledger.state, owner).listings;
  const published = typeof listings === 'object' && listings !== null ? Object.keys(listings) : [];
  return [...new Set([...products.map((product) => product.d), ...published])].sort();
}

/**
 * A moved store's former owners as the sweep treats them: `anchored`, the
 * former owner buyers still read while the latest move has not switched
 * (swept as the owner is); `revoked`, the others (only their 30490 at S).
 */
export interface FormerOwnerSweep {
  anchored: string[];
  revoked: string[];
}

const NO_FORMER_OWNERS: FormerOwnerSweep = { anchored: [], revoked: [] };

/** How the sweep treats the store's former owners, from its moves (oldest first). */
export function formerOwnerSweep(
  moves: readonly { fromOwner: string; switchedAt: number | undefined }[],
): FormerOwnerSweep {
  const latest = moves.at(-1);
  const anchored =
    latest !== undefined && latest.switchedAt === undefined ? [latest.fromOwner] : [];
  return {
    anchored,
    revoked: moves.map((move) => move.fromOwner).filter((owner) => !anchored.includes(owner)),
  };
}

/** Every filter a store's sweep reads, each side alike. */
async function readStoreEvents(
  read: (filter: Filter) => Promise<NostrEvent[]>,
  owner: string,
  storePubkey: string,
  ds: readonly string[],
  former: FormerOwnerSweep = NO_FORMER_OWNERS,
): Promise<NostrEvent[]> {
  const listingAddresses = ds.map((d) => productAddress({ storePubkey, d }));
  // One after another: a relay limits the subscriptions open at once.
  const events: NostrEvent[] = [
    ...(await read({ kinds: [KIND_STORE_PROFILE, KIND_INBOX_RELAYS], authors: [storePubkey] })),
  ];
  for (const author of [owner, ...former.anchored]) {
    events.push(
      ...(await read({ kinds: [KIND_PAYTO], authors: [author] })),
      ...(await read({ kinds: [KIND_STORE_AUTH], authors: [author], '#d': [storePubkey] })),
      ...(await read({
        kinds: [KIND_DELETION],
        authors: [author],
        '#a': [storeAuthAddress(author, storePubkey), payoutListAddress(author)],
      })),
    );
  }
  if (former.revoked.length > 0) {
    events.push(
      ...(await read({ kinds: [KIND_STORE_AUTH], authors: former.revoked, '#d': [storePubkey] })),
    );
  }
  events.push(
    ...(await readListingChunks(ds, (chunk) =>
      read({ kinds: [KIND_PRODUCT], authors: [storePubkey], '#d': chunk }),
    )),
  );
  events.push(
    ...(await readListingChunks(listingAddresses, (chunk) =>
      read({ kinds: [KIND_DELETION], authors: [storePubkey], '#a': chunk }),
    )),
  );
  return events;
}

/**
 * The addresses of a store a reader resolves (the profile and inbox list have
 * no deletion read). A deletion of the payout list is mirrored but covers
 * nothing: the checkout takes the newest genuine 10133 and never applies a
 * deletion to it (commerce `verifyOffer`), so a reader of the required relay
 * must find the same 10133 a reader of the default relays does.
 */
function storeAddresses(
  owner: string,
  storePubkey: string,
  ds: readonly string[],
  former: FormerOwnerSweep = NO_FORMER_OWNERS,
): MirrorAddress[] {
  return [
    ...[owner, ...former.anchored].flatMap((author) => [
      {
        kind: KIND_STORE_AUTH,
        author,
        d: storePubkey,
        deletion: storeAuthAddress(author, storePubkey),
        deletionCovers: true,
      },
      {
        kind: KIND_PAYTO,
        author,
        deletion: payoutListAddress(author),
        deletionCovers: false,
      },
    ]),
    ...former.revoked.map((author) => ({ kind: KIND_STORE_AUTH, author, d: storePubkey })),
    { kind: KIND_STORE_PROFILE, author: storePubkey },
    { kind: KIND_INBOX_RELAYS, author: storePubkey },
    ...ds.map((d) => ({
      kind: KIND_PRODUCT,
      author: storePubkey,
      d,
      deletion: productAddress({ storePubkey, d }),
      deletionCovers: true,
    })),
  ];
}

/**
 * What the required relay lacks, deletions first: the exact signed events to
 * copy there. `source` is what the default relays serve (judged as a reader
 * does, at `now`); `required` what the required relay served (whatever it
 * keeps, however far its date).
 */
export function mirrorPlan(
  source: readonly NostrEvent[],
  required: readonly NostrEvent[],
  addresses: readonly MirrorAddress[],
  now: number,
): NostrEvent[] {
  const deletions = new Map<string, NostrEvent>();
  const events: NostrEvent[] = [];
  for (const address of addresses) {
    let coveredUpTo: number | undefined;
    if (address.deletion !== undefined) {
      const sourceDeletion = newestDeletion(
        source,
        address.deletion,
        address.author,
        NO_FUTURE_LIMIT,
      );
      const requiredDeletion = newestDeletion(
        required,
        address.deletion,
        address.author,
        NO_FUTURE_LIMIT,
      );
      if (
        sourceDeletion !== undefined &&
        (requiredDeletion === undefined || requiredDeletion.created_at < sourceDeletion.created_at)
      ) {
        deletions.set(sourceDeletion.id, sourceDeletion);
      }
      const dates = [sourceDeletion?.created_at, requiredDeletion?.created_at].filter(
        (date): date is number => date !== undefined,
      );
      coveredUpTo =
        address.deletionCovers !== true || dates.length === 0 ? undefined : Math.max(...dates);
    }
    const newest = newestSigned(source, address.kind, address.author, now, address.d);
    if (newest === undefined || (coveredUpTo !== undefined && coveredUpTo >= newest.created_at)) {
      continue;
    }
    const held = newestSigned(required, address.kind, address.author, NO_FUTURE_LIMIT, address.d);
    // The reader's rule: the newest, and of two in the same second the lowest id.
    if (
      held === undefined ||
      held.created_at < newest.created_at ||
      (held.created_at === newest.created_at && newest.id < held.id)
    ) {
      events.push(newest);
    }
  }
  return [...deletions.values(), ...events];
}

/**
 * The events the required relay serves for `filter`, read to its EOSE on
 * `relay` alone. Throws `RequiredNotRead` on a timeout or a closed
 * subscription; a relay that asks for authentication first is answered as S
 * once and asked again.
 */
async function readRequired(
  relay: MirrorRelay,
  filter: Filter,
  auth: AuthSigner,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const first = await subscribeToEose(relay, filter, timeoutMs, signal);
  if (first.kind === 'events') {
    return first.events;
  }
  if (first.kind === 'closed' && first.reason.startsWith('auth-required')) {
    await untilStopped(relay.auth(auth), signal);
    const again = await subscribeToEose(relay, filter, timeoutMs, signal);
    if (again.kind === 'events') {
      return again.events;
    }
  }
  throw new RequiredNotRead(first.kind === 'closed' ? first.reason : 'no EOSE in time');
}

type ReadEnd =
  | { kind: 'events'; events: NostrEvent[] }
  | { kind: 'closed'; reason: string }
  | { kind: 'timeout' };

/** One subscription to its EOSE, a timeout or a CLOSED; rejects with `SweepStopped` (closing it) on a stop. */
function subscribeToEose(
  relay: MirrorRelay,
  filter: Filter,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadEnd> {
  if (signal.aborted) {
    return Promise.reject(new SweepStopped());
  }
  return new Promise<ReadEnd>((resolve, reject) => {
    const events: NostrEvent[] = [];
    let settled = false;
    let subscription: { close: () => void } | undefined;
    const finish = (end: ReadEnd | SweepStopped): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      subscription?.close();
      if (end instanceof SweepStopped) {
        reject(end);
      } else {
        resolve(end);
      }
    };
    const onAbort = (): void => finish(new SweepStopped());
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    try {
      subscription = relay.subscribe([filter], {
        onevent: (event) => {
          events.push(event);
        },
        oneose: () => finish({ kind: 'events', events }),
        onclose: (reason) => finish({ kind: 'closed', reason }),
        // Past our own deadline: nostr-tools' would fire `oneose` without an EOSE.
        eoseTimeout: timeoutMs * 2,
      });
      if (settled) {
        subscription.close();
      }
    } catch (error) {
      finish({ kind: 'closed', reason: errorText(error) });
    }
  });
}

/** The sweep loop: a tick claims the due stores one by one and sweeps each it claimed. Ticks never overlap. */
export class MirrorSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<StoreSweep[]> | undefined;
  /** Aborted by `stop`: no store is claimed after it, and the store in progress gives up at once. */
  private readonly stopping = new AbortController();

  constructor(private readonly deps: MirrorSweeperDeps) {}

  /** Sweep the stores due now; resolves to what each claimed store's sweep did. */
  runOnce(): Promise<StoreSweep[]> {
    if (this.stopping.signal.aborted) {
      return Promise.resolve([]);
    }
    this.running ??= this.tick().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Run a tick every `intervalMs` until `stop`. */
  start(intervalMs = MIRROR_TICK_MS): void {
    this.timer ??= setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.log(`mirror sweep failed: ${errorText(error)}`);
      });
    }, intervalMs);
  }

  /**
   * No tick after this and no store claimed after this; the store in progress
   * stops at once (its reads and sends are abandoned, its pool destroyed), so
   * this resolves after at most the database call in flight.
   */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopping.abort();
    await this.running?.catch(() => undefined);
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => console.error(line)))(message);
  }

  private async tick(): Promise<StoreSweep[]> {
    const { db } = this.deps;
    const dueBefore = this.deps.now() - MIRROR_SWEEP_SECS;
    const due = await db.query<DueStore>(
      `select s.owner, s.store_pubkey, k.store_key
       from stores s join store_keys k on k.owner = s.owner
       where coalesce(s.mirror_swept_at, 0) < $1
       order by coalesce(s.mirror_swept_at, 0), s.owner limit $2`,
      [dueBefore, MIRROR_STORES_PER_TICK],
    );
    const sweeps: StoreSweep[] = [];
    for (const store of due) {
      if (this.stopping.signal.aborted) {
        break;
      }
      if (!(await this.claim(store.owner))) {
        continue;
      }
      try {
        sweeps.push(await this.sweep(store));
      } catch (error) {
        if (error instanceof SweepStopped) {
          // Its claim stands: the store waits for the next period.
          this.log(`mirror ${store.owner.slice(0, 12)}: stopped`);
          continue;
        }
        this.log(`mirror ${store.owner.slice(0, 12)}: ${errorText(error)}`);
        sweeps.push({ owner: store.owner, outcome: 'skipped', reason: errorText(error) });
      }
    }
    return sweeps;
  }

  /** This period's sweep of the store, unless another instance (or an earlier tick) claimed it. */
  private async claim(owner: string): Promise<boolean> {
    const now = this.deps.now();
    const claimed = await this.deps.db.query(
      `update stores set mirror_swept_at = $2
       where owner = $1 and coalesce(mirror_swept_at, 0) < $3 returning 1`,
      [owner, now, now - MIRROR_SWEEP_SECS],
    );
    return claimed.length > 0;
  }

  private async sweep(store: DueStore): Promise<StoreSweep> {
    const { deps } = this;
    const { owner, store_pubkey: storePubkey } = store;
    const { signal } = this.stopping;
    // A stop that landed during the claim: read nothing more, not even the ledger.
    if (signal.aborted) {
      throw new SweepStopped();
    }
    const label = `mirror ${owner.slice(0, 12)}`;
    const timeoutMs = deps.readTimeoutMs ?? MIRROR_READ_TIMEOUT_MS;
    const ds = await listingDs(deps.db, owner, signal);
    // A stop during the last ledger read: read nothing more.
    if (signal.aborted) {
      throw new SweepStopped();
    }
    const former = formerOwnerSweep(await storeMoves(deps.db, storePubkey));
    // A stop during the moves read: open no pool and start no relay read.
    if (signal.aborted) {
      throw new SweepStopped();
    }
    const auth = storeAuth(deps.vault.open(store.store_key, owner, 'store'));
    const pool = deps.makePool();
    try {
      const source = await readStoreEvents(
        (filter) =>
          untilStopped(
            pool
              .querySync([...(deps.defaultRelays ?? OFFER_RELAYS)], filter, { maxWait: timeoutMs })
              .catch(() => []),
            signal,
          ),
        owner,
        storePubkey,
        ds,
        former,
      );
      let required: NostrEvent[];
      try {
        const relay = await untilStopped(pool.ensureRelay(deps.requiredRelay), signal);
        required = await readStoreEvents(
          (filter) => readRequired(relay, filter, auth, timeoutMs, signal),
          owner,
          storePubkey,
          ds,
          former,
        );
      } catch (error) {
        if (error instanceof SweepStopped) {
          throw error;
        }
        const reason = error instanceof RequiredNotRead ? error.message : errorText(error);
        this.log(`${label}: ${deps.requiredRelay} not read (${reason}): skipped this round`);
        return { owner, outcome: 'skipped', reason };
      }
      const plan = mirrorPlan(
        source,
        required,
        storeAddresses(owner, storePubkey, ds, former),
        deps.now(),
      );
      if (plan.length > MIRROR_SEND_CAP) {
        this.log(`${label}: ${plan.length} events missing, ${MIRROR_SEND_CAP} sent this round`);
      }
      let sent = 0;
      let refused = 0;
      for (const event of plan.slice(0, MIRROR_SEND_CAP)) {
        const accepted = await untilStopped(
          publishToRelays(
            pool,
            [deps.requiredRelay],
            event,
            auth,
            (message) =>
              this.log(`${label}: kind ${event.kind} ${event.id.slice(0, 12)}: ${message}`),
            deps.deadlineMs ?? PUBLISH_DEADLINE_MS,
          ),
          signal,
        );
        if (accepted.includes(deps.requiredRelay)) {
          sent += 1;
        } else {
          refused += 1;
        }
      }
      return { owner, outcome: 'swept', sent, refused };
    } finally {
      pool.destroy();
    }
  }
}
