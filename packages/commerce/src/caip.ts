import {
  type Asset,
  type ChainConfig,
  assetsFor,
  chainByCaip2,
  isEvmWireAddress,
  isVirtualEvmAddress,
} from '@elisym/pay-core';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CAIP19_RE = /^([a-z0-9-]{3,8}:[-_a-zA-Z0-9]{1,32})\/(token|erc20):([-.%a-zA-Z0-9]{1,128})$/;

export interface Caip19 {
  /** The full id, exactly as written. */
  id: string;
  caip2: string;
  chain: ChainConfig;
  /** The registry coin it names, on that chain's environment. */
  asset: Asset;
}

/**
 * Parse a CAIP-19 id for a coin the payment registry knows: `solana:<ref>/token:<mint>`
 * or `eip155:<id>/erc20:<lowercase contract>`. Anything else - an unknown chain,
 * a namespace that does not fit the chain, a coin the registry does not hold -
 * is `undefined`: an asset nothing can pay in is not an asset.
 */
export function parseCaip19(id: string): Caip19 | undefined {
  const match = CAIP19_RE.exec(id);
  const caip2 = match?.[1];
  const namespace = match?.[2];
  const reference = match?.[3];
  if (!caip2 || !namespace || !reference) {
    return undefined;
  }
  const chain = chainByCaip2(caip2);
  if (!chain) {
    return undefined;
  }
  const expectedNamespace = chain.family === 'solana' ? 'token' : 'erc20';
  if (namespace !== expectedNamespace) {
    return undefined;
  }
  if (chain.family === 'evm' && !isEvmWireAddress(reference)) {
    return undefined;
  }
  const asset = assetsFor(chain.slug, chain.network).find((coin) => coin.mint === reference);
  if (!asset) {
    return undefined;
  }
  return { id, caip2, chain, asset };
}

/**
 * The one canonical spelling of a payout address on a chain, or `undefined` if it
 * is not one. EVM addresses are lowercase on the wire, so every comparison is
 * plain equality; a virtual (TIP-1022) address is refused, as the payment rail does.
 */
export function canonicalPayoutAddress(chain: ChainConfig, address: string): string | undefined {
  if (chain.family === 'solana') {
    return SOLANA_ADDRESS_RE.test(address) ? address : undefined;
  }
  const lowered = address.toLowerCase();
  if (!isEvmWireAddress(lowered) || isVirtualEvmAddress(lowered)) {
    return undefined;
  }
  return lowered;
}
