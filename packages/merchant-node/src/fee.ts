/**
 * The protocol fee as the merchant node sees it. The node does not enforce the
 * rate - it is the merchant's software - but it must know which addresses are
 * elisym treasuries, so a payment split between the merchant and one of them
 * (the price less the fee to the merchant, the fee to the treasury) is credited.
 *
 * The treasuries come from the one fee source, the Solana `elisym-config`
 * program, read over a config RPC whose genesis hash must match the network
 * before any of its answers is used. Every fresh read records the addresses it
 * named; an address stays known for the catch-up window after the last read
 * that named it (a payment composed before a rotation may still land), and the
 * last read's addresses stay known whatever their age.
 */
import {
  type Network,
  type ProtocolConfig,
  MAX_FEE_BPS,
  calculateProtocolFeeSubunits,
  chainFor,
  getProtocolConfig,
  getProtocolProgramId,
} from '@elisym/pay-core';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import type { MerchantConfig } from './config';
import { CATCH_UP_SECS, FEE_CONFIG_READ_TIMEOUT_MS, ORDER_SCAN_MARGIN_SECS } from './constants';
import type { KnownTreasuries, LedgerState } from './ledger';

/** How long a treasury stays known after the last read that named it: an order's whole catch-up. */
export const TREASURY_RETENTION_SECS = CATCH_UP_SECS + ORDER_SCAN_MARGIN_SECS;

export type TreasuryRail = 'solana' | 'evm';

/**
 * The least the merchant's own leg may carry for a price: the price less a fee
 * at the program's cap (`MAX_FEE_BPS`, 10%). Below it a payment is never a
 * split, whatever went to a treasury.
 */
export function paymentFloor(price: bigint): bigint {
  return price - calculateProtocolFeeSubunits(price, MAX_FEE_BPS);
}

/**
 * The treasuries of `network`'s config on `rail` this node may credit a split
 * to at `now`: every one named within `TREASURY_RETENTION_SECS`, and the last
 * read's whatever its age.
 */
export function knownTreasuries(
  state: LedgerState,
  network: Network,
  rail: TreasuryRail,
  now: number,
): string[] {
  const entry = state.treasuries[network];
  if (entry === undefined) {
    return [];
  }
  const known = Object.entries(entry[rail])
    .filter(([, lastSeen]) => lastSeen >= now - TREASURY_RETENTION_SECS)
    .map(([address]) => address);
  const latest = entry.latest?.[rail];
  if (latest !== undefined && !known.includes(latest)) {
    known.push(latest);
  }
  return known;
}

/** Whether a fresh, genesis-checked read of `network`'s config was ever recorded in this home. */
export function hasKnownTreasuries(state: LedgerState, network: Network): boolean {
  return state.treasuries[network]?.latest !== undefined;
}

/**
 * Record what one fresh config read named, whatever the rate (a fee of 0 today
 * may be raised tomorrow), and forget what fell out of the window.
 */
export function recordTreasuryRead(
  state: LedgerState,
  network: Network,
  read: { treasury: string; evmTreasury: string | undefined },
  now: number,
): void {
  const entry: KnownTreasuries = state.treasuries[network] ?? { solana: {}, evm: {} };
  entry.solana[read.treasury] = now;
  if (read.evmTreasury !== undefined) {
    entry.evm[read.evmTreasury] = now;
  }
  entry.latest = {
    solana: read.treasury,
    ...(read.evmTreasury === undefined ? {} : { evm: read.evmTreasury }),
  };
  for (const rail of ['solana', 'evm'] as const) {
    for (const [address, lastSeen] of Object.entries(entry[rail])) {
      if (lastSeen < now - TREASURY_RETENTION_SECS) {
        delete entry[rail][address];
      }
    }
  }
  state.treasuries[network] = entry;
}

/**
 * The config RPC: `feeConfigRpcUrl`, else the Solana rail's `rpcUrl` (same
 * network), else the network's public endpoint. Never the other way round: a
 * config RPC alone switches on no Solana rail.
 */
export function feeConfigRpcUrl(
  config: Pick<MerchantConfig, 'network' | 'rpcUrl' | 'feeConfigRpcUrl'>,
): string {
  if (config.feeConfigRpcUrl !== undefined) {
    return config.feeConfigRpcUrl;
  }
  if (config.rpcUrl !== undefined) {
    return config.rpcUrl;
  }
  const [publicUrl] = chainFor('solana', config.network).rpcUrls;
  if (publicUrl === undefined) {
    throw new Error(`no public Solana endpoint for ${config.network}`);
  }
  return publicUrl;
}

export type TreasuryRefresh =
  /** A fresh read was recorded; `feeBps` is the rate it named. */
  | { kind: 'read'; feeBps: number }
  /** Nothing usable now (the endpoint down, a cached answer): asked again next time. */
  | { kind: 'unreachable'; problem: string }
  /** The endpoint serves another cluster: nothing was read, nothing may be. */
  | { kind: 'wrong_cluster'; problem: string };

/**
 * Reads the treasuries from one config RPC. Its genesis hash is checked before
 * the first read is used; an endpoint that cannot be reached then is checked on
 * the first contact that answers. A mismatch reads nothing (the process-wide
 * config cache must never hold another cluster's values) and is answered every
 * time it is asked. A read that takes longer than `timeoutMs` is unreachable,
 * and records nothing when it answers later.
 */
export class TreasuryReader {
  private genesisMatched = false;

  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly network: Network,
    private readonly readConfig: typeof getProtocolConfig = getProtocolConfig,
    private readonly timeoutMs: number = FEE_CONFIG_READ_TIMEOUT_MS,
  ) {}

  /** Read the config now and record its treasuries in `state` (the caller saves). */
  async refresh(state: LedgerState, now: number): Promise<TreasuryRefresh> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<TreasuryRefresh>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve({
          kind: 'unreachable',
          problem: `the fee config RPC did not answer within ${this.timeoutMs} ms`,
        });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.read(state, now, () => expired), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async read(
    state: LedgerState,
    now: number,
    expired: () => boolean,
  ): Promise<TreasuryRefresh> {
    if (!this.genesisMatched) {
      let genesisHash: unknown;
      try {
        genesisHash = await this.rpc.getGenesisHash().send();
      } catch (error) {
        return { kind: 'unreachable', problem: errorText(error) };
      }
      const expected = chainFor('solana', this.network).caip2;
      if (typeof genesisHash !== 'string' || `solana:${genesisHash.slice(0, 32)}` !== expected) {
        return {
          kind: 'wrong_cluster',
          problem: `the fee config RPC does not serve Solana ${this.network} (its genesis hash is not ${expected})`,
        };
      }
      this.genesisMatched = true;
    }
    let read: ProtocolConfig;
    try {
      read = await this.readConfig(this.rpc, getProtocolProgramId(this.network), this.network, {
        forceRefresh: true,
      });
    } catch (error) {
      return { kind: 'unreachable', problem: errorText(error) };
    }
    // A snapshot served from cache on an RPC error says nothing about today.
    if (read.source !== 'onchain') {
      return { kind: 'unreachable', problem: 'the config could not be read fresh' };
    }
    // Answered past the deadline: the caller has moved on, and may have saved.
    if (expired()) {
      return { kind: 'unreachable', problem: 'the config was read past the deadline' };
    }
    recordTreasuryRead(state, this.network, read, now);
    return { kind: 'read', feeBps: read.feeBps };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `run` and `check` say about a store profile without the fee tag (`undefined`: nothing to say). */
export function profileFeeWarning(
  profileFound: boolean,
  feeSupport: boolean,
  feeBps: number | undefined,
): string | undefined {
  if (!profileFound || feeSupport) {
    return undefined;
  }
  const base =
    'the store profile the relays serve does not declare protocol-fee support: buyers refuse this store while the protocol fee is above 0 - re-run setup';
  return feeBps !== undefined && feeBps > 0
    ? `${base}. THE PROTOCOL FEE IS ${feeBps} bps NOW: buyers are refusing this store`
    : base;
}

/**
 * Whether `setup` declares protocol-fee support, after its own config read:
 * only when this home holds treasuries for the network (only fresh,
 * genesis-checked reads write them, so they are the stored proof of a past
 * genesis pass) - a re-run during a short outage keeps the declaration. A
 * config RPC of another cluster refuses the setup before anything is published.
 */
export function feeDeclaration(
  state: LedgerState,
  network: Network,
  refresh: TreasuryRefresh,
): { declare: boolean; warning?: string } {
  if (refresh.kind === 'wrong_cluster') {
    throw new Error(`${refresh.problem}: nothing was published (fix feeConfigRpcUrl or rpcUrl)`);
  }
  const declare = hasKnownTreasuries(state, network);
  if (!declare) {
    return {
      declare,
      warning: `the elisym fee config could not be read (${refresh.kind === 'unreachable' ? refresh.problem : 'no answer'}) and never was in this home: the store is published WITHOUT protocol-fee support, and buyers refuse it while the protocol fee is above 0. Run setup again once the fee config RPC answers.`,
    };
  }
  if (refresh.kind === 'unreachable') {
    return {
      declare,
      warning: `the elisym fee config could not be read now (${refresh.problem}): fee support is declared with the treasuries read before`,
    };
  }
  return { declare };
}
