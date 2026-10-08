/**
 * The protocol fee a commerce payment carries, on every rail, from ONE source:
 * the Solana `elisym-config` program. Tempo reads it too - Tempo mainnet pairs
 * with the Solana mainnet config, Moderato with the devnet one - and takes the
 * program's `evm_treasury` as its treasury.
 *
 * `protocolFeeFor` is the one place a commerce buyer chooses the rate (a
 * per-merchant override will land there), `feeAmountFor` the one formula that
 * turns it into an amount, and `readFeeTerms` the one read that feeds both.
 */

import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { MAX_FEE_BPS, getProtocolProgramId } from '../constants';
import {
  CHAINS,
  chainFor,
  isEvmAddressFormat,
  isPayable,
  normalizeEvmAddress,
} from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import type { Network } from '../types';
import type { ProtocolConfig } from './onchain';
import { getProtocolConfig } from './onchain';

/** The rail a fee is paid on. Each has its own treasury in the one config. */
export type FeeRail = 'solana' | 'tempo';

/** The rate and the treasury a payment's fee leg uses. */
export interface FeeTerms {
  feeBps: number;
  /**
   * Solana: the config's `treasury` (base58). Tempo: its `evm_treasury`
   * (lowercase `0x`). `''` when `feeBps` is 0 - there is no fee leg to send.
   */
  treasury: string;
}

/**
 * Why the fee terms cannot be used.
 * - `unavailable`: the config could not be read fresh (rpc down, nothing
 *   cached). Ask again.
 * - `wrong_cluster`: the rpc answers for another cluster than the one asked
 *   about. A configuration error; asking again will not help.
 * - `no_evm_treasury`: a fee above 0 on Tempo, and the config names no EVM
 *   treasury.
 * - `bad_config`: a rate above `MAX_FEE_BPS`, or an EVM treasury no payment
 *   can go to.
 */
export type FeeConfigErrorCode = 'unavailable' | 'wrong_cluster' | 'no_evm_treasury' | 'bad_config';

export class FeeConfigError extends Error {
  readonly code: FeeConfigErrorCode;

  constructor(code: FeeConfigErrorCode, message: string) {
    super(message);
    this.name = 'FeeConfigError';
    this.code = code;
  }
}

/**
 * The fee terms for `rail` under `config`. `_owner` (the merchant) is the key
 * of a future per-merchant override and is not read yet. Throws
 * `FeeConfigError`: `bad_config` for a rate above `MAX_FEE_BPS`; on Tempo with
 * a rate above 0, `no_evm_treasury` when the config names none and
 * `bad_config` when it names one no payment can go to.
 */
export function protocolFeeFor(
  config: Pick<ProtocolConfig, 'feeBps' | 'treasury' | 'evmTreasury'>,
  rail: FeeRail,
  _owner?: string,
): FeeTerms {
  const { feeBps } = config;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new FeeConfigError(
      'bad_config',
      `The protocol fee rate is not one of 0-${MAX_FEE_BPS} bps.`,
    );
  }
  if (feeBps === 0) {
    return { feeBps: 0, treasury: '' };
  }
  if (rail === 'solana') {
    return { feeBps, treasury: config.treasury };
  }
  if (config.evmTreasury === undefined) {
    throw new FeeConfigError('no_evm_treasury', 'The protocol config names no EVM treasury.');
  }
  const treasury = normalizeEvmAddress(config.evmTreasury);
  if (treasury === undefined || !isPayable(treasury)) {
    throw new FeeConfigError(
      'bad_config',
      'The protocol config names an EVM treasury no payment can go to.',
    );
  }
  return { feeBps, treasury };
}

/** One address on either rail: EVM case-insensitively, base58 exactly. */
function sameAddress(first: string, second: string): boolean {
  if (isEvmAddressFormat(first) && isEvmAddressFormat(second)) {
    return first.toLowerCase() === second.toLowerCase();
  }
  return first === second;
}

/**
 * THE commerce fee on `price` (subunits): `ceil(price * feeBps / 10000)`. `0n`
 * means "no fee leg", and is the answer when the rate is 0, when the treasury
 * IS the payout or the payer (a self-transfer leg is never bound, and a Tempo
 * payer cannot pay itself), or when the fee would take the whole price (a
 * 1-subunit price). Composers take this AMOUNT, never the rate, so nothing
 * downstream recomputes it differently.
 */
export function feeAmountFor(
  price: bigint,
  terms: FeeTerms,
  parties: { payout: string; payer?: string },
): bigint {
  if (
    sameAddress(terms.treasury, parties.payout) ||
    (parties.payer !== undefined && sameAddress(terms.treasury, parties.payer))
  ) {
    return 0n;
  }
  const fee = calculateProtocolFeeSubunits(price, terms.feeBps);
  return fee >= price ? 0n : fee;
}

/** Explicit, not read off the registry: a chain added there gets no fee config by accident. */
const CONFIG_NETWORK_BY_CHAIN: ReadonlyMap<string, Network> = new Map<string, Network>([
  [CHAINS.SOLANA_MAINNET.caip2, 'mainnet'],
  [CHAINS.SOLANA_DEVNET.caip2, 'devnet'],
  [CHAINS.TEMPO_MAINNET.caip2, 'mainnet'],
  [CHAINS.TEMPO_DEVNET.caip2, 'devnet'],
]);

/**
 * The config network a chain's fee is read from: a Solana chain's own, Tempo
 * mainnet -> `mainnet`, Moderato -> `devnet`. Throws for any other chain.
 */
export function solanaConfigNetworkFor(caip2: string): Network {
  const network = CONFIG_NETWORK_BY_CHAIN.get(caip2);
  if (network === undefined) {
    throw new Error('No elisym fee config is paired with that chain.');
  }
  return network;
}

/**
 * The networks each rpc client has PROVEN to serve, by genesis hash. Only a
 * match is remembered: a failure or a mismatch is asked again next time.
 */
const genesisMatches = new WeakMap<object, Set<Network>>();

/** Whether `rpc` serves `network`, by its genesis hash; throws `unavailable` when it cannot say. */
async function servesNetwork(rpc: Rpc<SolanaRpcApi>, network: Network): Promise<boolean> {
  if (genesisMatches.get(rpc)?.has(network)) {
    return true;
  }
  let genesisHash: string;
  try {
    genesisHash = await rpc.getGenesisHash().send();
  } catch (error) {
    throw new FeeConfigError(
      'unavailable',
      `Could not read the genesis hash: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof genesisHash !== 'string' ||
    `solana:${genesisHash.slice(0, 32)}` !== chainFor('solana', network).caip2
  ) {
    return false;
  }
  const matched = genesisMatches.get(rpc) ?? new Set<Network>();
  matched.add(network);
  genesisMatches.set(rpc, matched);
  return true;
}

/**
 * The fee terms for `rail`, read fresh from the `network` config.
 *
 * The rpc's genesis hash is checked FIRST, and a mismatch reads nothing: the
 * process-wide `getProtocolConfig` cache is keyed by program and network, and
 * agent-job payments in the same process read it - a devnet endpoint wired as
 * mainnet must never write devnet's treasury there. Then the config is read
 * with `forceRefresh`, and only an `onchain` answer is used: a snapshot served
 * from cache on an rpc error is `unavailable`, never a fee.
 *
 * Throws `FeeConfigError`: `unavailable` (genesis or config unreadable - ask
 * again), `wrong_cluster`, and `protocolFeeFor`'s codes.
 */
export async function readFeeTerms(
  rpc: Rpc<SolanaRpcApi>,
  network: Network,
  rail: FeeRail,
): Promise<FeeTerms> {
  if (!(await servesNetwork(rpc, network))) {
    throw new FeeConfigError('wrong_cluster', `The Solana rpc does not serve ${network}.`);
  }
  let config: ProtocolConfig;
  try {
    config = await getProtocolConfig(rpc, getProtocolProgramId(network), network, {
      forceRefresh: true,
    });
  } catch (error) {
    throw new FeeConfigError(
      'unavailable',
      `Could not read the protocol config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (config.source !== 'onchain') {
    throw new FeeConfigError('unavailable', 'The protocol config could not be read fresh.');
  }
  return protocolFeeFor(config, rail);
}
