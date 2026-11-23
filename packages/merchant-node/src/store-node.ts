import type { Eip1193Client } from '@elisym/pay-core/evm';
import { type Rpc, type SolanaRpcApi, createSolanaRpc } from '@solana/kit';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { type MerchantConfig, hasSolanaRail } from './config';
import { CATCH_UP_INTERVAL_MS, SOLANA_MEDIUMS, WEBHOOK_TICK_MS } from './constants';
import { deliverOrder, publishSelfCopy } from './deliver';
import { type Eip3009Context, storeMediums } from './eip3009';
import type { TreasuryRefresh } from './fee';
import { storeIdentity } from './intake';
import type { LedgerState, WebhookOutbox } from './ledger';
import { InboxListener, type ListenerPool } from './listener';
import { type Product, intakeProductIds } from './products';
import type { PublishPool } from './publish';
import { MerchantRuntime } from './runtime';
import { SelfCopies } from './self-copies';
import { tempoContextFor } from './tempo';
import { type FetchLike, WebhookSender, type WebhookTarget } from './webhook';

/** The default Solana RPC when the config names none. */
const DEFAULT_SOLANA_RPC_URL = 'https://api.devnet.solana.com';

export interface StoreNodeWebhook {
  target: WebhookTarget;
  userAgent: string;
  /** The HTTP client for the requests; a host passes one that refuses private addresses. */
  fetch?: FetchLike;
}

export interface StoreNodeDeps {
  pool: ListenerPool & PublishPool;
  config: MerchantConfig;
  products: ReadonlyMap<string, Product>;
  /** The ledger, already opened, upgraded and checked against the relays. */
  state: LedgerState;
  storePubkey: string;
  storeSecretKey: Uint8Array;
  /** Write `state` to storage; awaited before anything is sent. */
  save: () => void | Promise<void>;
  /** A Solana RPC client shared by the host's stores; default: one built from `config.rpcUrl`. */
  solanaRpc?: Rpc<SolanaRpcApi>;
  /** A Tempo RPC client shared by the host's stores; default: one built from `config.tempo`. */
  tempoClient?: Eip1193Client;
  /** Read the fee config and record its treasuries in `state`, at the start of each sweep. */
  refreshTreasuries: () => Promise<TreasuryRefresh>;
  /** The Ethereum, Arbitrum and Base contexts, already behind their start check. */
  eip3009: Eip3009Context[];
  /** Present when the store has a webhook: payments then queue it in the save that records them. */
  outbox?: WebhookOutbox;
  webhook?: StoreNodeWebhook;
  log: (message: string) => void;
  now: () => number;
  /**
   * This store must stop: the fee config RPC serves another cluster, or (with
   * `haltOnSaveFailure`) a save failed. The CLI stops the process.
   */
  stop: (problem: string) => void;
  /**
   * A failed save halts this store for good (no task, timer or subscription
   * goes on) and calls `stop`: for a host whose storage refuses a writer that
   * lost its lease, so it reloads instead of going on with unsaved memory.
   * Without it the failure is logged and the store goes on; its next save
   * writes the whole ledger again (the CLI, writing one file).
   */
  haltOnSaveFailure?: boolean;
  /**
   * Relays read for orders besides `config.inboxRelays`, never written to:
   * the inbox a host just moved away from, where buyers holding its old
   * inbox list (10050) still send. Replies and copies go to
   * `config.inboxRelays` only. They count for the resume point like the
   * inbox relays (a wrap there is never skipped on a restart).
   */
  extraListenRelays?: readonly string[];
}

/** One running store: its runtime and the handle that stops it. */
export interface StoreNode {
  readonly runtime: MerchantRuntime;
  readonly selfCopies: SelfCopies;
  /**
   * Stop for good: no new task is taken, every timer and subscription ends, and
   * it resolves once the task in progress (with its save) is done. Sends already
   * running off the queue (a webhook request, a repeated completion, the copies
   * queue) may still finish; their outcome is not saved, so a webhook is sent
   * again by the next run (at least once, deduplicated by its event id).
   */
  stop: () => Promise<void>;
}

/** Answers a relay's NIP-42 challenge with the store key. */
export function storeAuth(storeSecretKey: Uint8Array) {
  return async (template: EventTemplate) => finalizeEvent(template, storeSecretKey);
}

/**
 * Run one store: listen on its inbox relays, sweep the chains, deliver and send
 * webhooks. Every ledger change runs on this store's one queue, and is saved
 * before anything is sent. Nothing here touches the process (signals, exit,
 * env): the host decides. Rejects, listening to nothing, when the first save
 * (where it resumes from) fails.
 */
export async function startStoreNode(deps: StoreNodeDeps): Promise<StoreNode> {
  const { pool, config, state, storePubkey, storeSecretKey, outbox, log, now } = deps;
  // Parsed before anything starts: a bad URL refuses the start, never a running store.
  const webhookOrigin =
    deps.webhook === undefined ? undefined : new URL(deps.webhook.target.url).origin;
  let stopped = false;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    if (stopped) {
      return;
    }
    queue = queue
      .then(async () => {
        if (!stopped) {
          await task();
        }
      })
      .catch((error: unknown) => {
        log(`error: ${errorText(error)}`);
      });
  };
  const later = (ms: number, task: () => void) => {
    if (stopped) {
      return;
    }
    const handle = setTimeout(() => {
      timeouts.delete(handle);
      task();
    }, ms);
    timeouts.add(handle);
  };
  const every = (ms: number, task: () => void) => {
    intervals.add(setInterval(task, ms));
  };

  const tempoContext = tempoContextFor(config, storePubkey);
  const tempo =
    tempoContext === undefined
      ? undefined
      : {
          ...tempoContext,
          ...(deps.tempoClient === undefined ? {} : { client: deps.tempoClient }),
          now,
          ...(outbox === undefined ? {} : { outbox }),
        };
  const mediums = storeMediums(
    hasSolanaRail(config) ? SOLANA_MEDIUMS[config.network] : undefined,
    tempo?.medium,
    deps.eip3009,
  );
  const auth = storeAuth(storeSecretKey);
  const save = async () => {
    try {
      await deps.save();
    } catch (error) {
      if (deps.haltOnSaveFailure === true && !stopped) {
        halt();
        deps.stop(`the ledger could not be saved: ${errorText(error)}`);
      }
      throw error;
    }
  };
  // The store's copies of its replies go to every inbox relay, whichever took the buyer copy.
  const selfCopies = new SelfCopies({
    publish: publishSelfCopy({ pool, inboxRelays: config.inboxRelays, auth, log }),
    log,
    later,
  });
  const store = storeIdentity(storePubkey, intakeProductIds(deps.products), mediums);
  const runtime = new MerchantRuntime({
    state,
    store,
    storeSecretKey,
    // With no Solana payout the Solana catch-up has no terms to scan and reads nothing.
    context: {
      rpc: deps.solanaRpc ?? createSolanaRpc(config.rpcUrl ?? DEFAULT_SOLANA_RPC_URL),
      network: config.network,
      now,
      ...(outbox === undefined ? {} : { outbox }),
    },
    ...(tempo === undefined ? {} : { tempo }),
    eip3009: deps.eip3009,
    // No Solana payout configured: the Solana sweep reads nothing (no cluster to guess).
    ...(hasSolanaRail(config) ? {} : { catchUp: async () => ({ paid: [], incomplete: [] }) }),
    refreshTreasuries: deps.refreshTreasuries,
    stop: deps.stop,
    save,
    // Completion needs no product: the status carries only the receipt.
    deliver: async (order, skip) =>
      await deliverOrder(
        { pool, inboxRelays: config.inboxRelays, storeSecretKey, auth, log, now },
        order,
        skip,
      ),
    selfCopies,
    inboxRelayCount: config.inboxRelays.length,
    log,
    now,
    later: (ms, task) => {
      later(ms, () => enqueue(task));
    },
  });
  const startedAt = now();
  const listenRelays = [...new Set([...config.inboxRelays, ...(deps.extraListenRelays ?? [])])];

  const listener = new InboxListener({
    pool,
    storePubkey,
    auth,
    onWrap: (wrap) => {
      if (runtime.admit(wrap)) {
        enqueue(() => runtime.handleWrap(wrap));
      }
    },
    log,
    now,
  });

  let sweepQueued = false;
  const sweep = () => {
    // A slow sweep never piles up behind itself on the queue.
    if (sweepQueued) {
      return;
    }
    sweepQueued = true;
    // Every wrap received before now is already on the queue, ahead of this sweep.
    const allLive = listener.allLive(listenRelays);
    const queuedAt = now();
    enqueue(async () => {
      sweepQueued = false;
      await runtime.sweep(allLive, queuedAt);
    });
  };

  // Resume from the last moment every inbox relay was read through. Recorded before
  // listening, so a run that never reads every relay through does not restart "from now".
  const resumeFrom = Math.min(state.resumeAt ?? startedAt, startedAt);
  state.resumeAt = resumeFrom;
  try {
    await deps.save();
  } catch (error) {
    halt();
    throw error;
  }
  for (const relay of listenRelays) {
    listener.listen(relay, resumeFrom);
  }
  log(`store ${storePubkey} listening on ${listenRelays.join(', ')}`);
  sweep();
  every(CATCH_UP_INTERVAL_MS, sweep);
  if (deps.webhook !== undefined && webhookOrigin !== undefined) {
    startWebhooks({ ...deps, save }, deps.webhook, store, enqueue, every);
    log(`webhook to ${webhookOrigin} (order.paid)`);
  }

  return {
    runtime,
    selfCopies,
    stop: async () => {
      halt();
      await queue;
    },
  };

  /** End every timer and subscription and take no task again (the one running finishes). */
  function halt(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    listener.close();
    for (const handle of timeouts) {
      clearTimeout(handle);
    }
    timeouts.clear();
    for (const handle of intervals) {
      clearInterval(handle);
    }
    intervals.clear();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send the webhooks due, every `WEBHOOK_TICK_MS`. Each pick runs on the queue,
 * between tasks, so it only sees entries already saved; the requests run off
 * it, and each outcome is queued back and saved.
 */
function startWebhooks(
  deps: StoreNodeDeps,
  webhook: StoreNodeWebhook,
  store: { storePubkey: string },
  enqueue: (task: () => Promise<void>) => void,
  every: (ms: number, task: () => void) => void,
): void {
  const { state, save, log, now } = deps;
  const sender = new WebhookSender({
    state,
    store,
    target: webhook.target,
    commit: (change) => {
      enqueue(async () => {
        change();
        await save();
      });
    },
    log,
    now,
    userAgent: webhook.userAgent,
    ...(webhook.fetch === undefined ? {} : { fetch: webhook.fetch }),
  });
  // Like the sweep: a busy queue holds one pick, never a pile of them.
  let tickQueued = false;
  const tick = () => {
    if (tickQueued) {
      return;
    }
    tickQueued = true;
    enqueue(async () => {
      tickQueued = false;
      void sender.tick();
    });
  };
  tick();
  every(WEBHOOK_TICK_MS, tick);
}
