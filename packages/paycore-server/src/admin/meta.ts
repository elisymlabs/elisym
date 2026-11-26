/**
 * `GET /v1/meta` (public, no authorization): what the hosted admin needs
 * before signing in - the base NIP-98 `u` is checked against, the operator
 * its 30490 must name, the coins a payout may use per network, the inbox
 * relay allowlist, a pending store's product cap and whether a store can
 * move to a new owner key. Nothing secret: the
 * operator's RPC URLs only decide which coins are listed, never appear.
 */
import { priceInSubunits } from '@elisym/commerce';
import { CHAINS, type ChainConfig, type Network, assetsFor } from '@elisym/pay-core';
import { type NetworkRpcs, type PaycoreConfig, hasOperatorRpc, publicBaseOf } from '../config';

export interface MetaView {
  publicBase: string;
  operator: string;
  networks: Record<Network, { coins: string[] }>;
  inboxRelays: string[];
  pendingMaxProducts: number;
  /** Whether the store move routes are served (PAYCORE_STORE_MOVES): the admin offers a move only then. */
  storeMoves: boolean;
}

/** Whether a coin can be paid a USD price 1:1 (a stablecoin): a product price is USD. */
function paysUsd(asset: Parameters<typeof priceInSubunits>[1]): boolean {
  try {
    priceInSubunits({ amount: '1', currency: 'USD' }, asset);
    return true;
  } catch {
    return false;
  }
}

/**
 * The CAIP-19 ids of the coins a payout on `network` may use: a USD coin of
 * a registry chain of that network whose rail has an operator RPC.
 */
export function servedCoins(rpcs: NetworkRpcs, network: Network): string[] {
  const chains: ChainConfig[] = Object.values(CHAINS);
  return chains
    .filter((chain) => chain.network === network && hasOperatorRpc(rpcs, chain))
    .flatMap((chain) =>
      assetsFor(chain.slug, network).flatMap((asset) =>
        asset.mint === undefined || !paysUsd(asset)
          ? []
          : [`${chain.caip2}/${chain.family === 'solana' ? 'token' : 'erc20'}:${asset.mint}`],
      ),
    );
}

export function metaView(
  config: Pick<PaycoreConfig, 'publicBase' | 'operator' | 'rpcs' | 'inboxRelays' | 'storeMoves'>,
  pendingMaxProducts: number,
): MetaView {
  return {
    publicBase: publicBaseOf(config.publicBase),
    operator: config.operator,
    networks: {
      mainnet: { coins: servedCoins(config.rpcs.mainnet, 'mainnet') },
      devnet: { coins: servedCoins(config.rpcs.devnet, 'devnet') },
    },
    inboxRelays: [...config.inboxRelays],
    pendingMaxProducts,
    storeMoves: config.storeMoves,
  };
}
