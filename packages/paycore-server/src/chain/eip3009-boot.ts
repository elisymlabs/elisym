import type { Eip1193Client } from '@elisym/pay-core/evm';
/**
 * The EIP-3009 start check, once per chain for the whole process instead of
 * once per store: each chain's operator RPC is checked at boot, and every
 * store's context for that chain carries the shared outcome as its `gate`.
 *
 * A wrong answer at boot throws (the boot stops: the operator's config is
 * wrong for every store). A transient failure leaves the chain deferred and is
 * checked again in the background with backoff; while deferred, a store's
 * context holds a gate whose `nextAt` never comes, so `sweepEip3009` never runs
 * the check per store. A pass moves every registered context to `verified`; a
 * wrong answer after boot moves them to `failed` (off until a restart), as
 * `sweepEip3009` does for one store.
 */
import type { MerchantConfig } from '@merchant-node/config';
import { EIP3009_START_CHECK_BACKOFF_SECS } from '@merchant-node/constants';
import {
  type Eip3009Context,
  type Eip3009Gate,
  type Eip3009StartCheck,
  chainNameOf,
  eip3009ContextsFor,
  startCheckEip3009,
} from '@merchant-node/eip3009';

/** The store key of the check contexts: `startCheckEip3009` reads no store data. */
const CHECK_STORE_PUBKEY = '0'.repeat(64);

/** A deferred gate's `nextAt` for a store context: the shared check, not the store, retries. */
const NEVER = Number.MAX_SAFE_INTEGER;

export interface Eip3009BootOptions {
  /** The operator's `evm` RPCs, one config per network in use. */
  configs: readonly Pick<MerchantConfig, 'network' | 'evm'>[];
  /** The shared clients (`ChainClients.evm`). */
  clientFor: (rpcUrl: string) => Eip1193Client;
  log: (message: string) => void;
  /** Seconds. */
  now: () => number;
  check?: typeof startCheckEip3009;
  /** Waits between transient checks; resolves early once `signal` aborts (tests pass a fake). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffSecs?: readonly number[];
}

interface ChainEntry {
  context: Eip3009Context;
  gate: Eip3009Gate;
  registered: Set<Eip3009Context>;
}

export class Eip3009Boot {
  private readonly chains = new Map<string, ChainEntry>();
  private readonly retries: Promise<void>[] = [];
  private stopped = false;
  private readonly stopping = new AbortController();

  constructor(private readonly options: Eip3009BootOptions) {
    for (const config of options.configs) {
      for (const context of eip3009ContextsFor(config, CHECK_STORE_PUBKEY, {
        clientFor: options.clientFor,
      })) {
        if (!this.chains.has(context.chain.caip2)) {
          this.chains.set(context.chain.caip2, {
            context,
            gate: context.gate,
            registered: new Set(),
          });
        }
      }
    }
  }

  /** The CAIP-2 ids of the chains checked. */
  get chainIds(): string[] {
    return [...this.chains.keys()];
  }

  /** The shared gate of a chain, or `undefined` for a chain not checked here. */
  gateOf(caip2: string): Eip3009Gate | undefined {
    return this.chains.get(caip2)?.gate;
  }

  /**
   * Check every chain once. A wrong answer throws; a transient one leaves the
   * chain deferred and starts its background retries.
   */
  async start(): Promise<void> {
    const check = this.options.check ?? startCheckEip3009;
    for (const entry of this.chains.values()) {
      const outcome = await check(entry.context, this.options.now());
      if (outcome.kind === 'wrong') {
        this.stop();
        throw new Error(
          `${chainNameOf(entry.context)} RPC failed the start check: ${outcome.problem}`,
        );
      }
      if (outcome.kind === 'transient') {
        this.setGate(entry, this.deferredGate(entry, outcome.problem));
        this.retries.push(this.retry(entry));
        continue;
      }
      if (outcome.warning !== undefined) {
        this.options.log(`warning: ${chainNameOf(entry.context)}: ${outcome.warning}`);
      }
      this.setGate(entry, { kind: 'verified' });
    }
  }

  /** Resolves once no background check is left (every chain verified or failed, or stopped). */
  async settled(): Promise<void> {
    await Promise.all(this.retries);
  }

  /** End the background retries (at shutdown), cutting a backoff wait short. */
  stop(): void {
    this.stopped = true;
    this.stopping.abort();
  }

  /**
   * Give a store's contexts the shared gate of their chain, and keep them in
   * step with it until the returned function is called (the store stopped).
   */
  register(contexts: readonly Eip3009Context[]): () => void {
    const added: [ChainEntry, Eip3009Context][] = contexts.map((context) => {
      const entry = this.chains.get(context.chain.caip2);
      if (entry === undefined) {
        throw new Error(`${chainNameOf(context)} has no operator RPC checked at boot`);
      }
      return [entry, context];
    });
    for (const [entry, context] of added) {
      entry.registered.add(context);
      context.gate = storeGate(entry.gate);
    }
    return () => {
      for (const [entry, context] of added) {
        entry.registered.delete(context);
      }
    };
  }

  private async retry(entry: ChainEntry): Promise<void> {
    const check = this.options.check ?? startCheckEip3009;
    const sleep = this.options.sleep ?? defaultSleep;
    const name = chainNameOf(entry.context);
    while (!this.stopped && entry.gate.kind === 'deferred') {
      await sleep(this.backoffMs(entry.gate.attempts - 1), this.stopping.signal);
      if (this.stopped) {
        return;
      }
      const outcome = await checkOrTransient(check, entry.context, this.options.now());
      if (outcome.kind === 'transient') {
        this.setGate(entry, this.deferredGate(entry, outcome.problem));
        this.options.log(
          `WARNING: ${name} RPC not yet verified (${outcome.problem}); payments there are not being scanned`,
        );
        continue;
      }
      if (outcome.kind === 'wrong') {
        this.setGate(entry, { kind: 'failed', problem: outcome.problem });
        this.options.log(
          `error: ${name} RPC failed the start check: ${outcome.problem}; payments there are not scanned until a restart`,
        );
        return;
      }
      this.setGate(entry, { kind: 'verified' });
      this.options.log(
        `${name} RPC verified${outcome.warning === undefined ? '' : ` (warning: ${outcome.warning})`}; scanning payments there`,
      );
    }
  }

  private deferredGate(entry: ChainEntry, problem: string): Eip3009Gate {
    const attempts = entry.gate.kind === 'deferred' ? entry.gate.attempts : 0;
    return {
      kind: 'deferred',
      attempts: attempts + 1,
      nextAt: this.options.now() + this.backoffSecs(attempts),
      problem,
    };
  }

  private backoffSecs(attempt: number): number {
    const steps = this.options.backoffSecs ?? EIP3009_START_CHECK_BACKOFF_SECS;
    return steps[Math.min(Math.max(attempt, 0), steps.length - 1)] ?? 0;
  }

  private backoffMs(attempt: number): number {
    return this.backoffSecs(attempt) * 1000;
  }

  private setGate(entry: ChainEntry, gate: Eip3009Gate): void {
    entry.gate = gate;
    entry.context.gate = gate;
    for (const context of entry.registered) {
      context.gate = storeGate(gate);
    }
  }
}

/** A store's copy of a shared gate: a deferred one never comes due in the store's own sweep. */
function storeGate(gate: Eip3009Gate): Eip3009Gate {
  return gate.kind === 'deferred' ? { ...gate, nextAt: NEVER } : { ...gate };
}

/** A check that throws is a transient failure (logged as one), not a crash of the retry loop. */
async function checkOrTransient(
  check: typeof startCheckEip3009,
  context: Eip3009Context,
  now: number,
): Promise<Eip3009StartCheck> {
  try {
    return await check(context, now);
  } catch (error) {
    return {
      kind: 'transient',
      problem: `the start check threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
