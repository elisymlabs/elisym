import { readFileSync } from 'node:fs';
import {
  DELIVERY_METHODS,
  LIMITS,
  canonicalPayoutAddress,
  parseCaip19,
  priceInSubunits,
  splitNip05,
} from '@elisym/commerce';
import { EVM_ASSETS, type Network } from '@elisym/pay-core';
import { TEMPO_UNPAYABLE_ADDRESSES } from '@elisym/pay-core/evm';
import Decimal from 'decimal.js-light';
import { z } from 'zod';
import { checkoutRelaySpelling } from './relays';
import type { Delivery } from './reply';
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
  product: StoreConfig['product'] & {
    /** What the buyer gets once paid: a link (a Blossom URL is one) or text. */
    delivery: Delivery;
  };
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

const PRICE_RE = /^\d{1,9}(\.\d{1,6})?$/;

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
    product: z.object({
      d: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/, 'use 1-64 letters, digits, dots, dashes or underscores'),
      title: z.string().trim().min(1).max(200),
      description: z.string().max(LIMITS.MAX_CONTENT_LENGTH),
      summary: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
      priceUsd: z.string().refine((value) => PRICE_RE.test(value) && new Decimal(value).gt(0), {
        message: 'must be a USD amount above 0, such as "49" or "0.50"',
      }),
      delivery: z.object({
        method: z.enum(DELIVERY_METHODS),
        value: z.string().min(1).max(LIMITS.MAX_TAG_VALUE_LENGTH),
      }),
    }),
    payouts: z
      .array(
        z.object({
          caip19: z.string(),
          address: z.string(),
          signature: z.string().optional(),
        }),
      )
      .min(1),
  })
  .strict()
  .superRefine((config, context) => {
    // One relay under two spellings would count twice toward a delivery.
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
      // paid on another rail or network would never get a delivery.
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
      const price = config.product.priceUsd;
      if (PRICE_RE.test(price) && new Decimal(price).gt(0)) {
        try {
          priceInSubunits({ amount: price, currency: 'USD' }, caip19.asset);
        } catch {
          context.addIssue({
            code: 'custom',
            path: [...path, 'caip19'],
            message: `${caip19.asset.symbol} cannot be paid a USD price`,
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
    product: {
      d: 'my-product',
      title: 'My product',
      description: 'What the buyer gets.',
      priceUsd: '10',
      delivery: { method: 'access', value: 'https://example.com/<the link the buyer gets>' },
    },
    payouts: [{ caip19: usdc, address: '<your Solana wallet address>' }],
  };
}
