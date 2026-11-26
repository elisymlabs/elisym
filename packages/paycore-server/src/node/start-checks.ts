/**
 * What a store's start checks before its node runs (sub-plan step 9): the
 * ledger upgraded and saved through the fence before any relay or chain is
 * contacted; a ledger or products that cannot run refuse the start; offers
 * the relays serve and the ledger does not honour leave the store running
 * `degraded`, with a heal when the committed owner events can fix them; the
 * first fee config read; the EIP-3009 contexts behind the boot's shared gates.
 */
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { type QueryPool, type RelayView, newest } from '@merchant-node/checks';
import { type Eip3009Context, eip3009ContextsFor } from '@merchant-node/eip3009';
import type { TreasuryRefresh } from '@merchant-node/fee';
import {
  LEDGER_VERSION,
  type LedgerState,
  type WebhookOutbox,
  upgradeLedger,
} from '@merchant-node/ledger';
import {
  lostHistoryProblem,
  productPriceProblems,
  profileWarnings,
  readOfferProblems,
} from '@merchant-node/start-checks';
import type { Eip3009Boot } from '../chain/eip3009-boot';
import type { NetworkTreasuries } from '../chain/treasuries';
import type { FormerOwner } from '../state/move-rows';
import { driftProblems } from './drift';
import type { CommittedOwnerEvent, StoreBundle } from './load';

const KIND_PAYTO = 10133;

/** Restarts and heals wait this long after the first failure, doubling... */
export const CONTROL_BACKOFF_BASE_MS = 30_000;
/** ...up to this. */
export const CONTROL_BACKOFF_MAX_MS = 30 * 60_000;

/** The wait before retry `attempt` (0 = the first retry): 30 s doubling to 30 min, no jitter. */
export function controlBackoffMs(attempt: number): number {
  return Math.min(CONTROL_BACKOFF_MAX_MS, CONTROL_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16));
}

export interface StartCheckDeps {
  /** The store's own relay pool (P8): read for its inbox relays only. */
  pool: QueryPool;
  /** An unauthenticated, short-lived pool for the public offer relays (closed by the caller after the checks). */
  publicPool: QueryPool;
  treasuries: Pick<NetworkTreasuries, 'refreshFor'>;
  boot: Pick<Eip3009Boot, 'register'>;
  /** The shared EVM clients (`ChainClients.evm`). */
  evmClientFor: (rpcUrl: string) => Eip1193Client;
  log: (message: string) => void;
  /** Seconds. */
  now: () => number;
}

/** What the relays offer that the ledger does not honour, and whether a heal pass can fix it. */
export interface OfferVerdict {
  problems: string[];
  heal: boolean;
  /** The problem set, order-free: one heal per distinct set. */
  key: string;
}

export type StartCheckOutcome =
  | { kind: 'refused'; problem: string }
  | {
      kind: 'ready';
      eip3009: Eip3009Context[];
      /** Takes the contexts off the boot's gates: call once the node stopped. */
      unregister: () => void;
      outbox?: WebhookOutbox;
      /** Present when the relays offer what the ledger does not honour (the store runs `degraded`). */
      offers?: OfferVerdict;
      /** What the relays serve that the server never made (R1): the store runs `degraded`. */
      drift: string[];
      refresh: TreasuryRefresh;
    };

/**
 * Whether a setup pass with the committed owner events can fix what the
 * relays offer: their newest payout list is one the server committed, or
 * older than the newest committed one (a committed list that went out and was
 * never recorded is the first case), or a listing they serve is not the one
 * the ledger recorded. A newer payout list the server did not commit (R1
 * drift) is not fixed by republishing an older one: alert only.
 */
export function healable(
  views: readonly RelayView[],
  state: Pick<LedgerState, 'listings'>,
  committed: readonly CommittedOwnerEvent[],
): boolean {
  const listingsDiffer = views.some((view) =>
    view.listings.some((listing) => {
      const d = listing.tags.find((tag) => tag[0] === 'd')?.[1];
      return d === undefined || state.listings[d]?.eventId !== listing.id;
    }),
  );
  if (listingsDiffer) {
    return true;
  }
  const served = newest(
    views.flatMap((view) => (view.payoutList === undefined ? [] : [view.payoutList])),
  );
  if (served === undefined) {
    return true;
  }
  const lists = committed.filter((event) => event.kind === KIND_PAYTO);
  if (lists.some((event) => event.id === served.id)) {
    return true;
  }
  const newestCommitted = Math.max(...lists.map((event) => event.createdAt));
  return lists.length > 0 && served.created_at < newestCommitted;
}

/** The problem set as one string, independent of order. */
export function problemKey(problems: readonly string[]): string {
  return [...new Set(problems)].sort().join('\n');
}

/**
 * One heal per distinct problem set, spaced by `controlBackoffMs`: a set
 * already healed is not healed again (the store stays `degraded` with its
 * alert), and a new set waits for the backoff since the last heal.
 */
export class HealGate {
  private readonly healed = new Set<string>();
  private attempts = 0;
  private nextAt = 0;

  /** Milliseconds to wait before healing `key`, or `undefined` when it was healed already. */
  plan(key: string, nowMs: number): number | undefined {
    if (this.healed.has(key)) {
      return undefined;
    }
    this.healed.add(key);
    const at = Math.max(nowMs, this.nextAt);
    this.nextAt = at + controlBackoffMs(this.attempts);
    this.attempts += 1;
    return at - nowMs;
  }

  /** The store started with nothing to heal: a later problem set is healed at once. */
  reset(): void {
    this.healed.clear();
    this.attempts = 0;
    this.nextAt = 0;
  }
}

/**
 * A read pool over two: the store's inbox relays through its own pool (the
 * sockets it keeps, authenticated as its S), every other relay through
 * `publicPool` (unauthenticated, closed after the read), so a store keeps no
 * socket to the public offer relays for its whole run.
 */
export function splitReadPool(
  storePool: QueryPool,
  publicPool: QueryPool,
  inboxRelays: readonly string[],
): QueryPool {
  const own = new Set(inboxRelays);
  return {
    async querySync(relays, filter, params) {
      const mine = relays.filter((relay) => own.has(relay));
      const others = relays.filter((relay) => !own.has(relay));
      const publicParams = params.maxWait === undefined ? {} : { maxWait: params.maxWait };
      const [first, second] = await Promise.all([
        mine.length === 0 ? [] : storePool.querySync(mine, filter, params),
        others.length === 0 ? [] : publicPool.querySync(others, filter, publicParams),
      ]);
      const seen = new Set<string>();
      return [...first, ...second].filter((event) => {
        if (seen.has(event.id)) {
          return false;
        }
        seen.add(event.id);
        return true;
      });
    },
  };
}

/** What the relays serve for a store, judged: offers the ledger does not honour, and drift (R1). */
export interface OfferJudgement {
  offers: OfferVerdict | undefined;
  drift: string[];
  views: RelayView[];
}

/**
 * Read the relays' views of a store and judge them against its ledger and
 * the owner events the server committed: at start, and every
 * `DRIFT_CHECK_SECS` while it runs (a read only: the inbox relays through the
 * store's own pool, the public offer relays through `publicPool`).
 */
export async function judgeOffers(
  pools: { store: QueryPool; publicPool: QueryPool },
  store: Pick<StoreBundle, 'owner' | 'storePubkey' | 'config' | 'products' | 'committed'> & {
    state: LedgerState;
    /** The store's former owners (its moves): their profiles are judged by `driftProblems`. */
    formerOwners?: readonly FormerOwner[];
  },
): Promise<OfferJudgement> {
  const { owner, state, committed } = store;
  const served = await readOfferProblems(
    splitReadPool(pools.store, pools.publicPool, store.config.inboxRelays),
    store.config,
    { storePubkey: store.storePubkey, ownerPubkey: owner },
    state,
    store.products,
  );
  return {
    offers:
      served.problems.length === 0
        ? undefined
        : {
            problems: served.problems,
            heal: healable(served.views, state, committed),
            key: problemKey(served.problems),
          },
    drift: driftProblems(served.views, owner, committed, store.formerOwners ?? []),
    views: served.views,
  };
}

/**
 * Run a store's start checks, in order. Returns `refused` for a store whose
 * data cannot run; throws for a failure a retry may pass (a save refused, a
 * relay read that threw).
 */
export async function startChecks(
  bundle: StoreBundle,
  deps: StartCheckDeps,
): Promise<StartCheckOutcome> {
  const { owner, handle, config, products, storePubkey } = bundle;
  const { state, read } = upgradeLedger(handle.state, `the ledger of ${owner}`);
  if (read !== LEDGER_VERSION) {
    // Before any relay or chain: from here an older node refuses this ledger.
    await handle.save(state);
  }
  const lost = lostHistoryProblem(state, products);
  if (lost !== undefined) {
    return { kind: 'refused', problem: lost };
  }
  const prices = productPriceProblems(config, products.values());
  if (prices !== undefined) {
    return { kind: 'refused', problem: prices };
  }
  let offers: OfferVerdict | undefined;
  let views: RelayView[] = [];
  let drift: string[] = [];
  if (bundle.status !== 'pending') {
    const judged = await judgeOffers(
      { store: deps.pool, publicPool: deps.publicPool },
      { ...bundle, state },
    );
    ({ offers, views, drift } = judged);
  }
  const refresh = await deps.treasuries.refreshFor(config.network, state, deps.now());
  if (refresh.kind === 'wrong_cluster') {
    return { kind: 'refused', problem: refresh.problem };
  }
  if (refresh.kind === 'unreachable') {
    deps.log(
      `warning: the elisym fee config could not be read (${refresh.problem}); asked again every sweep`,
    );
  }
  for (const warning of profileWarnings(views, refresh)) {
    deps.log(`warning: ${warning}`);
  }
  // A webhook URL queues entries even without its secret yet: they are sent once one exists.
  const outbox: WebhookOutbox | undefined =
    config.webhook === undefined ? undefined : { storePubkey, now: deps.now };
  const eip3009 = eip3009ContextsFor(config, storePubkey, {
    clientFor: deps.evmClientFor,
    ...(outbox === undefined ? {} : { outbox }),
  });
  let unregister: () => void;
  try {
    unregister = deps.boot.register(eip3009);
  } catch (error) {
    return { kind: 'refused', problem: error instanceof Error ? error.message : String(error) };
  }
  return {
    kind: 'ready',
    eip3009,
    unregister,
    ...(outbox === undefined ? {} : { outbox }),
    ...(offers === undefined ? {} : { offers }),
    drift,
    refresh,
  };
}
