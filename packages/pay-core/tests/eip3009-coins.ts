/**
 * Every `eip3009` USDC in the registry: three chains, mainnet and devnet. A gate
 * tested on one chain only would pass when narrowed to that chain's slug, so the
 * settlement gating tests run over all of them.
 */
import { type Asset, assetsFor } from '../src/payment/assets';
import { CHAINS, type ChainConfig } from '../src/payment/chains';

export const EIP3009_USDC: readonly { chain: ChainConfig; asset: Asset; caip19: string }[] =
  Object.values(CHAINS).flatMap((chain: ChainConfig) =>
    chain.settlement === 'eip3009'
      ? assetsFor(chain.slug, chain.network).map((asset) => ({
          chain,
          asset,
          caip19: `${chain.caip2}/erc20:${asset.mint ?? ''}`,
        }))
      : [],
  );
