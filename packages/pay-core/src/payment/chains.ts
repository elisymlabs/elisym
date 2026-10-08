/**
 * The registry of chains a payment can settle on.
 *
 * A `network` (`mainnet` | `devnet`) is elisym's ENVIRONMENT; a chain is named
 * by its CAIP-2 id. One slug (`tempo`) covers both of a chain's environments,
 * the way `solana` always has - the slug is what a card and a SKILL.md carry,
 * the CAIP-2 id is what a v2 payment request carries.
 *
 * CAIP-2 forms: `solana:<first 32 chars of the genesis hash>` and
 * `eip155:<chain id>`. (`app/lib/cluster.ts` uses `solana:mainnet`, which is a
 * Wallet Standard chain id and NOT CAIP-2 - the two never mix.)
 *
 * This module is data and string checks only. Anything that needs keccak or an
 * rpc client lives under `@elisym/pay-core/evm`, which imports from here - never
 * the other way round.
 */

import type { Network } from '../types';
import { EVM_ASSETS } from './assets';

export type ChainSlug = 'solana' | 'tempo';
export type ChainFamily = 'solana' | 'evm';

export interface ChainConfig {
  slug: ChainSlug;
  family: ChainFamily;
  network: Network;
  caip2: string;
  /** EVM chains only: the numeric chain id `eth_chainId` must answer. */
  evmChainId?: number;
  /** Public endpoints, in order of preference. A client may configure its own. */
  rpcUrls: readonly string[];
  /** Explorer link for a transaction; `{tx}` is replaced by its id. */
  explorerTx: string;
  /**
   * EVM chains: the `ElisymConfig` contract clients read the fee and the treasury
   * from. Absent means elisym has no config on that chain yet, and nothing can be
   * priced there. The address comes from HERE only, never from a card or a request.
   */
  protocolConfig?: { address: string };
}

export const CHAINS = {
  SOLANA_MAINNET: {
    slug: 'solana',
    family: 'solana',
    network: 'mainnet',
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    rpcUrls: ['https://api.mainnet-beta.solana.com'],
    explorerTx: 'https://explorer.solana.com/tx/{tx}',
  },
  SOLANA_DEVNET: {
    slug: 'solana',
    family: 'solana',
    network: 'devnet',
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    rpcUrls: ['https://api.devnet.solana.com'],
    explorerTx: 'https://explorer.solana.com/tx/{tx}?cluster=devnet',
  },
  TEMPO_MAINNET: {
    slug: 'tempo',
    family: 'evm',
    network: 'mainnet',
    caip2: 'eip155:4217',
    evmChainId: 4217,
    rpcUrls: ['https://rpc.tempo.xyz'],
    explorerTx: 'https://explore.tempo.xyz/tx/{tx}',
  },
  // Moderato, Tempo's public testnet.
  TEMPO_DEVNET: {
    slug: 'tempo',
    family: 'evm',
    network: 'devnet',
    caip2: 'eip155:42431',
    evmChainId: 42431,
    rpcUrls: ['https://rpc.moderato.tempo.xyz'],
    explorerTx: 'https://explore.testnet.tempo.xyz/tx/{tx}',
    // Deployed 2026-09-20, tx 0x722e6cf1...a462; runtime code keccak256
    // 0x85c2c8ec...4520. See contracts/elisym-config-evm/DEPLOYMENTS.md.
    protocolConfig: { address: '0x5fbde74a7ddc8133123e824ffbe161a909342b3d' },
  },
} as const satisfies Record<string, ChainConfig>;

const ALL_CHAINS: readonly ChainConfig[] = Object.values(CHAINS);

const CHAIN_SLUGS: readonly ChainSlug[] = ['solana', 'tempo'];

export function isChainSlug(value: unknown): value is ChainSlug {
  return typeof value === 'string' && (CHAIN_SLUGS as readonly string[]).includes(value);
}

/** The family of a chain slug, or `undefined` for a slug this SDK does not know. */
export function chainFamilyOf(slug: string): ChainFamily | undefined {
  return ALL_CHAINS.find((chain) => chain.slug === slug)?.family;
}

/** Every registry chain has an entry per environment, so this never misses. */
export function chainFor(slug: ChainSlug, network: Network): ChainConfig {
  const found = ALL_CHAINS.find((chain) => chain.slug === slug && chain.network === network);
  if (!found) {
    throw new Error(`No registry entry for chain ${slug} on ${network}`);
  }
  return found;
}

export function chainByCaip2(caip2: string): ChainConfig | undefined {
  return ALL_CHAINS.find((chain) => chain.caip2 === caip2);
}

export function explorerTxUrl(chain: ChainConfig, tx: string): string {
  return chain.explorerTx.replace('{tx}', encodeURIComponent(tx));
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// TIP-1022: bytes 4..14 of a virtual address are ten 0xfd bytes. A transfer to
// one is forwarded to a master account and bypasses every receive-policy read,
// so v1 refuses the format wherever an address is accepted.
const VIRTUAL_ADDRESS_MARKER = 'fd'.repeat(10);
const VIRTUAL_MARKER_START = 2 + 4 * 2;

const EVM_WIRE_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EVM_WIRE_TX_HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * The WIRE form of an EVM address: lowercase. One canonical spelling, so every
 * comparison downstream (a card's address against a request's recipient) is plain
 * equality. Cards, payment requests and tags all use it.
 */
export function isEvmWireAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_WIRE_ADDRESS_RE.test(value);
}

/** The wire form of an EVM transaction hash: 32 bytes of lowercase hex. */
export function isEvmWireTxHash(value: unknown): value is string {
  return typeof value === 'string' && EVM_WIRE_TX_HASH_RE.test(value);
}

/** Shape only: `0x` and 40 hex characters, either case. No checksum (that needs keccak). */
export function isEvmAddressFormat(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value);
}

export function isEvmTxHashFormat(value: unknown): value is string {
  return typeof value === 'string' && EVM_TX_HASH_RE.test(value);
}

export function isVirtualEvmAddress(address: string): boolean {
  if (!isEvmAddressFormat(address)) {
    return false;
  }
  const marker = address
    .toLowerCase()
    .slice(VIRTUAL_MARKER_START, VIRTUAL_MARKER_START + VIRTUAL_ADDRESS_MARKER.length);
  return marker === VIRTUAL_ADDRESS_MARKER;
}

/** Lowercase form used on the wire, or `undefined` when `value` is not an EVM address. */
export function normalizeEvmAddress(value: unknown): string | undefined {
  return isEvmAddressFormat(value) ? value.toLowerCase() : undefined;
}

/** Twenty zero bytes: the burn address, and the `recoveryAuthority` that means "the originator". */
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** Tempo's TIP-403 receive-policy registry. */
export const TEMPO_POLICY_REGISTRY = '0x403c000000000000000000000000000000000000';
/** Tempo's guard that holds a blocked transfer's funds and emits `TransferBlocked`. */
export const TEMPO_TRANSFER_GUARD = '0xb10c000000000000000000000000000000000000';
/**
 * Tempo's fee sink. Every Tempo receipt ends with a transfer to it, on a
 * reverted transaction too - so a sender matching its own legs must never count
 * one.
 */
export const TEMPO_FEE_SINK = '0xfeec000000000000000000000000000000000000';
/** Tempo's TIP-1022 address registry precompile, live on mainnet. */
export const TEMPO_ADDRESS_REGISTRY = '0xfdc0000000000000000000000000000000000000';

/**
 * Addresses no payment of ours may name. Four are Tempo's own system accounts -
 * the policy registry, the transfer guard, the fee sink and the address
 * registry - and the fifth is the burn address: money sent to any of them is
 * gone, and nothing this SDK can read would ever report it as delivered - the
 * fee sink is excluded from every leg match by name.
 */
export const TEMPO_UNPAYABLE_ADDRESSES: readonly string[] = [
  ZERO_ADDRESS,
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TEMPO_FEE_SINK,
  TEMPO_ADDRESS_REGISTRY,
];

/** The contracts of every registry coin: a token precompile holds no one's balance. */
export const COIN_CONTRACTS: readonly string[] = EVM_ASSETS.flatMap((coin) =>
  coin.mint === undefined ? [] : [coin.mint.toLowerCase()],
);

/**
 * Whether money sent to the EVM `address` (wire form: lowercase) can reach
 * someone: not a virtual address, not one of the protocol's own system
 * accounts, and not a coin's own contract.
 */
export function isPayable(address: string): boolean {
  return (
    !isVirtualEvmAddress(address) &&
    !TEMPO_UNPAYABLE_ADDRESSES.includes(address) &&
    !COIN_CONTRACTS.includes(address)
  );
}
