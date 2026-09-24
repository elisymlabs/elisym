import {
  type Asset,
  type ChainConfig,
  assetsFor,
  chainByCaip2,
  isEvmWireAddress,
  isVirtualEvmAddress,
} from '@elisym/pay-core';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58, hex } from '@scure/base';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CAIP19_RE = /^([a-z0-9-]{3,8}:[-_a-zA-Z0-9]{1,32})\/(token|erc20):([-.%a-zA-Z0-9]{1,128})$/;

const SOLANA_PUBLIC_KEY_BYTES = 32;
/** 32 zero bytes (the System Program id): no one holds its key, so a payment there is burnt. */
const SOLANA_ZERO_KEY = '1'.repeat(32);
const EVM_ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const UTF8 = new TextEncoder();

function isSolanaPublicKey(address: string): boolean {
  try {
    return base58.decode(address).length === SOLANA_PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

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
 * Whether a mixed-case EVM address carries a valid EIP-55 checksum. An address
 * in one case has none to check and passes; a mixed-case one with a wrong
 * checksum is a typo.
 */
export function hasValidEvmChecksum(address: string): boolean {
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true;
  }
  const digest = hex.encode(keccak_256(UTF8.encode(body.toLowerCase())));
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    const nibble = Number.parseInt(digest[i] ?? '0', 16);
    const expected = nibble >= 8 ? char.toUpperCase() : char.toLowerCase();
    if (char !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * The one canonical spelling of a payout address on a chain, or `undefined` if it
 * is not one. EVM addresses are lowercase on the wire, so every comparison is
 * plain equality; a virtual (TIP-1022) address is refused, as the payment rail does.
 */
export function canonicalPayoutAddress(chain: ChainConfig, address: string): string | undefined {
  if (chain.family === 'solana') {
    return SOLANA_ADDRESS_RE.test(address) &&
      isSolanaPublicKey(address) &&
      address !== SOLANA_ZERO_KEY
      ? address
      : undefined;
  }
  const lowered = address.toLowerCase();
  // The zero address burns whatever is sent to it.
  if (!isEvmWireAddress(lowered) || isVirtualEvmAddress(lowered) || lowered === EVM_ZERO_ADDRESS) {
    return undefined;
  }
  return lowered;
}
