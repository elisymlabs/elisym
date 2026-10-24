import { CHAINS, type ChainConfig, settlementOf } from '@elisym/pay-core';

/**
 * The widget's own RPC of each `eip3009` chain (Ethereum, Arbitrum, Base and
 * their Sepolia testnets) comes from the build, one variable per chain and
 * network. A chain whose variable is unset is never offered: a build without
 * a mainnet variable offers no mainnet payout on that chain, whatever the
 * registry or a store publishes. There is no public fallback for these reads.
 */

/** Every `eip3009` chain of the registry. */
export const EIP3009_CHAINS: readonly ChainConfig[] = Object.values(CHAINS).filter(
  (chain) => settlementOf(chain) === 'eip3009',
);

/** `VITE_EVM_RPC_URL_<SLUG>_<NETWORK>`, e.g. `VITE_EVM_RPC_URL_BASE_DEVNET`. */
export function eip3009RpcEnvName(chain: Pick<ChainConfig, 'slug' | 'network'>): string {
  return `VITE_EVM_RPC_URL_${chain.slug.toUpperCase()}_${chain.network.toUpperCase()}`;
}

/** The build's RPC URL of each `eip3009` chain it serves, by CAIP-2; an empty variable is unset. */
export function eip3009RpcUrls(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  for (const chain of EIP3009_CHAINS) {
    const url = env[eip3009RpcEnvName(chain)];
    if (url !== undefined && url !== '') {
      urls.set(chain.caip2, url);
    }
  }
  return urls;
}
