import { readFileSync } from 'node:fs';
import type { Network } from '@elisym/pay-core';
import { EIP3009_SLUGS, type Eip3009Slug } from '@merchant-node/config';
import { checkoutRelaySpelling } from '@merchant-node/relays';

/** The inbox relays a hosted store may use unless PAYCORE_INBOX_RELAYS says otherwise (P7). */
export const DEFAULT_INBOX_RELAYS: readonly string[] = ['wss://relay.elisym.network'];
export const DEFAULT_PORT = 8790;
const MASTER_KEY_RE = /^[0-9a-f]{64}$/;
/** A DNS name as the 30490 `operator` names the service: labels of letters, digits and dashes. */
const OPERATOR_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

type Env = Readonly<Record<string, string | undefined>>;

/** The operator's RPCs on one network: the only ones a store's node uses (stores never name one). */
export interface NetworkRpcs {
  /** The Solana rail's RPC: Solana payouts on this network need it. */
  solana?: string;
  /** Where the fee config is read (default: `solana`, else the network's public endpoint). */
  fee?: string;
  /** The Tempo rail's RPC (Tempo mainnet on `mainnet`, Moderato on `devnet`). */
  tempo?: string;
  /** The `eip3009` chains' RPCs (USDC on Ethereum, Arbitrum, Base). */
  evm: Partial<Record<Eip3009Slug, string>>;
}

export interface PaycoreConfig {
  databaseUrl: string;
  /** The master key, 32 bytes as lowercase hex: never logged. */
  masterKeyHex: string;
  /** NIP-98 `u` is compared with this base (no trailing slash). */
  publicBase: string;
  port: number;
  trustProxy: boolean;
  /** The operator's allowlist of inbox relays, in the checkout's spelling (P7). */
  inboxRelays: string[];
  /** The 30490 `operator` of every hosted store (R2). */
  operator: string;
  rpcs: Record<Network, NetworkRpcs>;
}

/** An empty variable is an unset one. */
function withoutEmpty(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** The public base without a trailing slash: `https://x/` and `https://x` name the same base. */
export function publicBaseOf(value: string): string {
  return value.replace(/\/+$/u, '');
}

function rpcUrl(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!URL.canParse(value) || !['https:', 'http:'].includes(new URL(value).protocol)) {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value;
}

/** The env names of one network's operator RPCs. */
export function rpcEnvNames(network: Network): {
  solana: string;
  fee: string;
  tempo: string;
  evm: Record<Eip3009Slug, string>;
} {
  const suffix = network.toUpperCase();
  return {
    solana: `PAYCORE_SOLANA_RPC_${suffix}`,
    fee: `PAYCORE_FEE_RPC_${suffix}`,
    tempo: `PAYCORE_TEMPO_RPC_${suffix}`,
    evm: {
      ethereum: `PAYCORE_EVM_RPC_ETHEREUM_${suffix}`,
      arbitrum: `PAYCORE_EVM_RPC_ARBITRUM_${suffix}`,
      base: `PAYCORE_EVM_RPC_BASE_${suffix}`,
    },
  };
}

function networkRpcs(env: Env, network: Network): NetworkRpcs {
  const names = rpcEnvNames(network);
  const evm: Partial<Record<Eip3009Slug, string>> = {};
  for (const slug of EIP3009_SLUGS) {
    const url = rpcUrl(names.evm[slug], env[names.evm[slug]]);
    if (url !== undefined) {
      evm[slug] = url;
    }
  }
  const solana = rpcUrl(names.solana, env[names.solana]);
  const fee = rpcUrl(names.fee, env[names.fee]);
  const tempo = rpcUrl(names.tempo, env[names.tempo]);
  return {
    ...(solana === undefined ? {} : { solana }),
    ...(fee === undefined ? {} : { fee }),
    ...(tempo === undefined ? {} : { tempo }),
    evm,
  };
}

/**
 * PAYCORE_INBOX_RELAYS: comma-separated relays hosted stores may name as
 * their inbox (P7), each `wss:` on a public DNS name, kept in the checkout's
 * spelling. Unset: `wss://relay.elisym.network`.
 */
export function inboxRelaysFrom(value: string | undefined): string[] {
  if (value === undefined) {
    return [...DEFAULT_INBOX_RELAYS];
  }
  const relays: string[] = [];
  for (const entry of value.split(',').map((part) => part.trim())) {
    const spelling = checkoutRelaySpelling(entry);
    if (spelling === undefined) {
      throw new Error(
        `PAYCORE_INBOX_RELAYS names ${JSON.stringify(entry)}: each relay must be wss: on a public DNS name`,
      );
    }
    if (!relays.includes(spelling)) {
      relays.push(spelling);
    }
  }
  return relays;
}

/** The master key from PAYCORE_MASTER_KEY_FILE (a Docker secret) or PAYCORE_MASTER_KEY, never both. */
function masterKeyFrom(env: Env, read: (path: string) => string): string {
  const file = env.PAYCORE_MASTER_KEY_FILE;
  const direct = env.PAYCORE_MASTER_KEY;
  if (file !== undefined && direct !== undefined) {
    throw new Error('Set PAYCORE_MASTER_KEY_FILE or PAYCORE_MASTER_KEY, not both');
  }
  const key = file === undefined ? required(env, 'PAYCORE_MASTER_KEY') : read(file).trim();
  if (!MASTER_KEY_RE.test(key)) {
    throw new Error('The master key must be 32 bytes as lowercase hex');
  }
  return key;
}

function publicBaseFrom(value: string): string {
  const base = publicBaseOf(value);
  if (!URL.canParse(base)) {
    throw new Error('PAYCORE_PUBLIC_BASE must be a URL');
  }
  const url = new URL(base);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('PAYCORE_PUBLIC_BASE must be https (http only on localhost)');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('PAYCORE_PUBLIC_BASE must be a bare origin and path');
  }
  return base;
}

/**
 * PAYCORE_OPERATOR, the 30490 `operator` tag (R2): a DNS name, by default the
 * public base's host.
 */
function operatorFrom(value: string | undefined, publicBase: string): string {
  const operator = value ?? new URL(publicBase).hostname;
  if (!OPERATOR_RE.test(operator)) {
    throw new Error(`PAYCORE_OPERATOR must be a lowercase DNS name, got ${operator}`);
  }
  return operator;
}

function portFrom(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65_535) {
    throw new Error(`PORT must be a TCP port, got ${value}`);
  }
  return Number(value);
}

/** The server's settings from the environment, checked before anything starts. `read` is for tests. */
export function configFromEnv(
  rawEnv: Env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): PaycoreConfig {
  const env = withoutEmpty(rawEnv);
  const publicBase = publicBaseFrom(required(env, 'PAYCORE_PUBLIC_BASE'));
  const trust = env.PAYCORE_TRUST_PROXY;
  if (trust !== undefined && trust !== '1' && trust !== '0') {
    throw new Error('PAYCORE_TRUST_PROXY must be 1 or 0');
  }
  const rpcs = { mainnet: networkRpcs(env, 'mainnet'), devnet: networkRpcs(env, 'devnet') };
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    masterKeyHex: masterKeyFrom(env, read),
    publicBase,
    port: portFrom(env.PORT),
    trustProxy: trust === '1',
    inboxRelays: inboxRelaysFrom(env.PAYCORE_INBOX_RELAYS),
    operator: operatorFrom(env.PAYCORE_OPERATOR, publicBase),
    rpcs,
  };
}
