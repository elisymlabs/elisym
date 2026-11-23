/**
 * The fee config of every network in use, read for all stores at once: one
 * `TreasuryReader` per network (its genesis check runs once per process), and
 * every store asking within `TREASURY_SHARE_SECS` of a read gets that read,
 * recorded in its own ledger at the moment it was made.
 */
import type { Network } from '@elisym/pay-core';
import { type TreasuryRefresh, TreasuryReader, recordTreasuryRead } from '@merchant-node/fee';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import type { Rpc, SolanaRpcApi } from '@solana/kit';

/** Reads of one network's config made within this many seconds are shared. */
export const TREASURY_SHARE_SECS = 60;

interface TreasuryRead {
  treasury: string;
  evmTreasury: string | undefined;
}

interface SharedRead {
  /** Seconds: when the read started; its treasuries are recorded at this moment. */
  readAt: number;
  refresh: TreasuryRefresh;
  /** What a `read` named; absent for the other outcomes. */
  read?: TreasuryRead;
}

interface NetworkEntry {
  reader: TreasuryReader;
  latest?: SharedRead;
  inFlight?: Promise<SharedRead>;
}

export interface NetworkTreasuriesOptions {
  /** The config RPC of each network in use (the operator's fee RPC, else its Solana RPC). */
  rpcs: Partial<Record<Network, Rpc<SolanaRpcApi>>>;
  /** For tests: what `TreasuryReader` reads the config with. */
  readConfig?: ConstructorParameters<typeof TreasuryReader>[2];
  timeoutMs?: number;
}

export class NetworkTreasuries {
  private readonly entries = new Map<Network, NetworkEntry>();

  constructor(options: NetworkTreasuriesOptions) {
    for (const [network, rpc] of Object.entries(options.rpcs) as [
      Network,
      Rpc<SolanaRpcApi> | undefined,
    ][]) {
      if (rpc !== undefined) {
        this.entries.set(network, {
          reader: new TreasuryReader(rpc, network, options.readConfig, options.timeoutMs),
        });
      }
    }
  }

  get networks(): Network[] {
    return [...this.entries.keys()];
  }

  /**
   * The first read of every network, before any store starts. A config RPC of
   * another cluster throws (the boot stops); one that cannot be reached now is
   * read again when a store asks.
   */
  async boot(now: number): Promise<Map<Network, TreasuryRefresh>> {
    const outcomes = new Map<Network, TreasuryRefresh>();
    for (const network of this.entries.keys()) {
      const { refresh } = await this.shared(network, now);
      if (refresh.kind === 'wrong_cluster') {
        throw new Error(`fee config of ${network}: ${refresh.problem}`);
      }
      outcomes.set(network, refresh);
    }
    return outcomes;
  }

  /**
   * A store's `refreshTreasuries`: the network's read of the last
   * `TREASURY_SHARE_SECS` (or a fresh one, shared with every store asking
   * meanwhile), recorded in `state` at the read's own time. The caller saves.
   */
  async refreshFor(network: Network, state: LedgerState, now: number): Promise<TreasuryRefresh> {
    const shared = await this.shared(network, now);
    if (shared.read !== undefined) {
      recordTreasuryRead(state, network, shared.read, shared.readAt);
    }
    return shared.refresh;
  }

  private shared(network: Network, now: number): Promise<SharedRead> {
    const entry = this.entries.get(network);
    if (entry === undefined) {
      throw new Error(`no fee config RPC for ${network}`);
    }
    const { latest } = entry;
    if (latest !== undefined && now >= latest.readAt && now - latest.readAt < TREASURY_SHARE_SECS) {
      return Promise.resolve(latest);
    }
    if (entry.inFlight !== undefined) {
      return entry.inFlight;
    }
    const inFlight = readNetwork(entry.reader, network, now)
      .then((shared) => {
        entry.latest = shared;
        return shared;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
    entry.inFlight = inFlight;
    return inFlight;
  }
}

async function readNetwork(
  reader: TreasuryReader,
  network: Network,
  readAt: number,
): Promise<SharedRead> {
  const scratch = emptyLedger();
  const refresh = await reader.refresh(scratch, readAt);
  const latest = scratch.treasuries[network]?.latest;
  if (refresh.kind !== 'read' || latest === undefined) {
    return { readAt, refresh };
  }
  return { readAt, refresh, read: { treasury: latest.solana, evmTreasury: latest.evm } };
}
