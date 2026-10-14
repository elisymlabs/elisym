/**
 * Which coins a USD figure is given for: the registry's dollar pegs only (USDC
 * on Solana, both mints; USDC.e and pathUSD on Tempo), at their registry
 * decimals. SOL and LSM are reported in their own subunits: no price oracle.
 */
import {
  type Asset,
  PATHUSD_TEMPO,
  USDCE_TEMPO_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  assetsFor,
} from '@elisym/pay-core';
import type { Rail, StatsNetwork } from './aggregate';

const USD_PEGS: readonly Asset[] = [
  USDC_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  USDCE_TEMPO_MAINNET,
  PATHUSD_TEMPO,
];

const USD_DECIMALS = new Map(USD_PEGS.map((asset) => [asset.symbol, asset.decimals]));

/** The registry asset of `mint` (`undefined`: the native coin) on this rail and network. */
export function registryAsset(
  rail: Rail,
  network: StatsNetwork,
  mint: string | undefined,
): Asset | undefined {
  return assetsFor(rail, network).find((asset) =>
    mint === undefined
      ? asset.mint === undefined
      : asset.mint?.toLowerCase() === mint.toLowerCase(),
  );
}

/** The coin column: the registry symbol, or the raw mint / token of a coin the registry does not know. */
export function coinOf(rail: Rail, network: StatsNetwork, mint: string | undefined): string {
  return registryAsset(rail, network, mint)?.symbol ?? mint ?? 'native';
}

/** The decimals of a USD peg by its coin column, or `undefined` for any other coin. */
export function usdDecimalsOf(coin: string): number | undefined {
  return USD_DECIMALS.get(coin);
}
