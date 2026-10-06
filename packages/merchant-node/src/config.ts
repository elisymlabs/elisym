import { readFileSync } from 'node:fs';
import {
  canonicalPayoutAddress,
  isPublicHostname,
  parseCaip19,
  priceInSubunits,
  splitNip05,
} from '@elisym/commerce';
import { EVM_ASSETS, type Network } from '@elisym/pay-core';
import { TEMPO_UNPAYABLE_ADDRESSES } from '@elisym/pay-core/evm';
import { z } from 'zod';
import { OLD_HOME_PROBLEM } from './ledger';
import type { Product } from './products';
import { checkoutRelaySpelling } from './relays';
import type { StoreConfig } from './store-events';

export type TempoNetwork = 'mainnet' | 'moderato';

export interface MerchantConfig extends StoreConfig {
  network: Network;
  /**
   * A Solana RPC for the network, server-side (a browser-restricted key will not
   * do). Required only when a Solana payout is configured.
   */
  rpcUrl?: string;
  /** Present when the store takes Tempo payouts: the network, and a server-side RPC. */
  tempo?: { network: TempoNetwork; rpcUrl?: string };
  /** Where the node tells the merchant's backend about each payment it verified. */
  webhook?: WebhookConfig;
}

export interface WebhookConfig {
  url: string;
  /** Allows `http:`, and a host that is not a public DNS name (local tests). */
  allowInsecure?: boolean;
}

/** At most this many inbox relays: each is read and written for every order. */
const MAX_INBOX_RELAYS = 5;

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

/** A URL with one of `secure` as its scheme, or `insecure` on this machine only. */
function urlWith(secure: string, insecure: string) {
  return z.string().refine(
    (value) => {
      if (!URL.canParse(value)) {
        return false;
      }
      const url = new URL(value);
      return url.protocol === secure || (url.protocol === insecure && isLocalHost(url.hostname));
    },
    { message: `must be a ${secure}// URL` },
  );
}

/**
 * Why a webhook URL is refused, or `undefined`. The URL is the merchant's own,
 * so this guards a mistake, not an attacker: https to a public DNS name, unless
 * `allowInsecure` says a plain or local endpoint is meant.
 */
export function webhookUrlProblem(value: string, allowInsecure: boolean): string | undefined {
  if (!URL.canParse(value)) {
    return 'must be a URL';
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'must be an https:// URL';
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not hold a user name or password';
  }
  if (allowInsecure) {
    return undefined;
  }
  if (url.protocol !== 'https:') {
    return 'must be an https:// URL (set "allowInsecure": true for a plain http endpoint)';
  }
  if (!isPublicHostname(url.hostname)) {
    return 'must name a public DNS host (set "allowInsecure": true for a local or private one)';
  }
  return undefined;
}

const configSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    nip05: z
      .string()
      .refine((value) => splitNip05(value) !== undefined, { message: 'is not a nip05 address' })
      // nostr.json names the owner key "owner": the store cannot take that name.
      .refine((value) => splitNip05(value)?.local !== 'owner', {
        message: 'cannot use the name "owner" (it names the owner key)',
      })
      .optional(),
    network: z.enum(['mainnet', 'devnet']),
    rpcUrl: urlWith('https:', 'http:').optional(),
    tempo: z
      .object({
        network: z.enum(['mainnet', 'moderato']),
        rpcUrl: urlWith('https:', 'http:').optional(),
      })
      .strict()
      .optional(),
    inboxRelays: z
      .array(
        urlWith('wss:', 'ws:').refine(
          (value) => value.startsWith('ws:') || checkoutRelaySpelling(value) !== undefined,
          { message: 'must be a relay the checkout contacts: wss: on a public DNS name' },
        ),
      )
      .min(1)
      .max(MAX_INBOX_RELAYS),
    payouts: z
      .array(
        z.object({
          caip19: z.string(),
          address: z.string(),
          signature: z.string().optional(),
        }),
      )
      .min(1),
    // Only `order.paid` for now: an `events` list can come later without a break.
    webhook: z
      .object({ url: z.string(), allowInsecure: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.webhook !== undefined) {
      const problem = webhookUrlProblem(config.webhook.url, config.webhook.allowInsecure === true);
      if (problem !== undefined) {
        context.addIssue({ code: 'custom', path: ['webhook', 'url'], message: problem });
      }
    }
    // One relay under two spellings would count twice toward a completion.
    const spellings = config.inboxRelays.map(
      (relay) => checkoutRelaySpelling(relay) ?? relay.replace(/\/+$/, ''),
    );
    spellings.forEach((spelling, index) => {
      if (spellings.indexOf(spelling) !== index) {
        context.addIssue({
          code: 'custom',
          path: ['inboxRelays', index],
          message: 'is listed twice',
        });
      }
    });
    const seen = new Set<string>();
    let solanaPayouts = 0;
    config.payouts.forEach((payout, index) => {
      const path = ['payouts', index];
      const caip19 = parseCaip19(payout.caip19);
      // The node verifies payments on its configured networks only: a buyer who
      // paid on another rail or network would never be completed.
      if (caip19 === undefined) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'caip19'],
          message: 'must be a coin this node can verify',
        });
        return;
      }
      if (caip19.chain.family === 'evm') {
        if (config.tempo === undefined) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'caip19'],
            message: 'is a Tempo coin: add a "tempo" block for the node to verify it',
          });
          return;
        }
        const wanted = tempoRegistryNetwork(config.tempo.network);
        if (caip19.chain.network !== wanted) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'caip19'],
            message: `is not on Tempo ${config.tempo.network}`,
          });
        }
        if (
          canonicalPayoutAddress(caip19.chain, payout.address) !== payout.address ||
          !isPayableTempoAddress(payout.address)
        ) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'address'],
            message:
              'is not a Tempo address a payment can go to (lowercase 0x, not a system or coin address)',
          });
        }
      } else {
        solanaPayouts += 1;
        if (caip19.chain.network !== config.network) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'caip19'],
            message: `is on ${caip19.chain.network}, the node runs on ${config.network}`,
          });
        }
        if (canonicalPayoutAddress(caip19.chain, payout.address) !== payout.address) {
          context.addIssue({
            code: 'custom',
            path: [...path, 'address'],
            message: 'is not a Solana address',
          });
        }
      }
      if (seen.has(caip19.id)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'caip19'],
          message: 'is listed twice: one payout per coin',
        });
      }
      seen.add(caip19.id);
    });
    // A page shows the payouts on its own network only, and anyone can frame a level C
    // store: Moderato on a mainnet store would let a testnet coin pay for a real order.
    if (
      config.tempo !== undefined &&
      tempoRegistryNetwork(config.tempo.network) !== config.network
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tempo', 'network'],
        message: `is ${config.tempo.network}, the node runs on ${config.network}: use network "mainnet" with Tempo "mainnet", or network "devnet" with Tempo "moderato"`,
      });
    }
    if (solanaPayouts > 0 && config.rpcUrl === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rpcUrl'],
        message: 'is required with a Solana payout',
      });
    }
  });

/** The registry's network name for a Tempo network: Moderato is Tempo's testnet. */
export function tempoRegistryNetwork(network: TempoNetwork): Network {
  return network === 'mainnet' ? 'mainnet' : 'devnet';
}

/** Not a Tempo system address, and not a coin's own contract: money sent there reaches no one. */
function isPayableTempoAddress(address: string): boolean {
  const coins = EVM_ASSETS.flatMap((coin) =>
    coin.mint === undefined ? [] : [coin.mint.toLowerCase()],
  );
  return !TEMPO_UNPAYABLE_ADDRESSES.includes(address) && !coins.includes(address);
}

type ParsedConfig = { ok: true; config: MerchantConfig } | { ok: false; problems: string[] };

function parseConfig(value: unknown): ParsedConfig {
  // A 0.7 config names its one product here: that home is not upgraded.
  if (typeof value === 'object' && value !== null && 'product' in value) {
    return { ok: false, problems: [OLD_HOME_PROBLEM] };
  }
  const parsed = configSchema.safeParse(value);
  if (parsed.success) {
    const config = parsed.data as MerchantConfig;
    // One spelling everywhere (published, listened on, compared with the default
    // relays): the checkout's. A local ws: test relay stays as written.
    config.inboxRelays = config.inboxRelays.map((relay) => checkoutRelaySpelling(relay) ?? relay);
    return { ok: true, config };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.length === 0 ? 'config' : issue.path.join('.')}: ${issue.message}`,
    ),
  };
}

/** Every problem with a config, one per line; empty when it is usable. */
export function configProblems(value: unknown): string[] {
  const parsed = parseConfig(value);
  return parsed.ok ? [] : parsed.problems;
}

/** Read and validate the config; throws with every problem found. */
export function loadConfig(path: string): MerchantConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseConfig(value);
  if (!parsed.ok) {
    throw new Error(`${path} is not usable:\n- ${parsed.problems.join('\n- ')}`);
  }
  return parsed.config;
}

/** The config `init` writes for the operator to fill in. */
export function configTemplate(network: Network): MerchantConfig {
  const usdc =
    network === 'mainnet'
      ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  return {
    name: 'My store',
    network,
    rpcUrl:
      network === 'mainnet'
        ? 'https://mainnet.helius-rpc.com/?api-key=<a server-side key>'
        : 'https://api.devnet.solana.com',
    inboxRelays: ['wss://relay.elisym.network', 'wss://nos.lol'],
    payouts: [{ caip19: usdc, address: '<your Solana wallet address>' }],
  };
}

/**
 * Every product price a configured payout cannot carry: a coin must be able to
 * pay each product's USD price, or that product's listing could not be paid.
 */
export function priceProblems(
  config: Pick<MerchantConfig, 'payouts'>,
  products: Iterable<Product>,
): string[] {
  const problems: string[] = [];
  for (const product of products) {
    for (const payout of config.payouts) {
      const caip19 = parseCaip19(payout.caip19);
      if (caip19 === undefined) {
        continue;
      }
      try {
        priceInSubunits({ amount: product.priceUsd, currency: 'USD' }, caip19.asset);
      } catch {
        problems.push(
          `products/${product.d}: ${caip19.asset.symbol} cannot be paid its price of ${product.priceUsd} USD`,
        );
      }
    }
  }
  return problems;
}
