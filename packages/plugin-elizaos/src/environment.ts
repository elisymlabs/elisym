import type { IAgentRuntime } from '@elizaos/core';
import bs58 from 'bs58';
import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { solToLamports } from './lib/pricing';

const HEX_64 = /^[0-9a-f]{64}$/i;

const modeSchema = z.enum(['customer', 'provider', 'both']);
const networkSchema = z.enum(['devnet', 'mainnet']);

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

export const ElisymConfigSchema = z
  .object({
    nostrPrivateKeyHex: z
      .string()
      .regex(HEX_64, 'Nostr private key must be 32-byte hex')
      .optional(),
    solanaPrivateKeyBase58: z.string().min(1, 'Solana private key is required'),
    network: networkSchema,
    relays: z.array(z.string().url()).optional(),
    solanaRpcUrl: z.string().url().optional(),
    mode: modeSchema,
    maxSpendPerJobLamports: z.bigint().positive(),
    maxSpendPerHourLamports: z.bigint().positive(),
    requireApprovalAboveLamports: z.bigint().nonnegative(),
    providerCapabilities: z.array(z.string().min(1)).optional(),
    providerPriceLamports: z
      .bigint()
      .positive()
      .refine((value) => value <= MAX_SAFE_LAMPORTS, {
        message: `ELISYM_PROVIDER_PRICE_SOL in lamports must be <= ${MAX_SAFE_LAMPORTS} (Number.MAX_SAFE_INTEGER); larger values cannot be published safely on the wire`,
      })
      .optional(),
    providerActionMap: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (cfg) => {
      if (cfg.mode === 'customer') {
        return true;
      }
      return (
        cfg.providerCapabilities !== undefined &&
        cfg.providerCapabilities.length > 0 &&
        cfg.providerPriceLamports !== undefined
      );
    },
    {
      message:
        'Provider mode requires ELISYM_PROVIDER_CAPABILITIES and ELISYM_PROVIDER_PRICE_SOL to be set',
    },
  );

export type ElisymConfig = z.infer<typeof ElisymConfigSchema>;

function normalizeNostrKey(input: string): string {
  if (input.startsWith('nsec')) {
    const decoded = nip19.decode(input);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec-encoded Nostr secret key');
    }
    return Buffer.from(decoded.data as Uint8Array).toString('hex');
  }
  if (!HEX_64.test(input)) {
    throw new Error('ELISYM_NOSTR_PRIVATE_KEY must be 32-byte hex or an nsec');
  }
  return input.toLowerCase();
}

function validateSolanaKey(base58: string): void {
  const bytes = bs58.decode(base58);
  if (bytes.length !== 64) {
    throw new Error('ELISYM_SOLANA_PRIVATE_KEY must decode to a 64-byte secret key');
  }
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseActionMap(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ELISYM_PROVIDER_ACTION_MAP is not valid JSON: ${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ELISYM_PROVIDER_ACTION_MAP must be a JSON object');
  }
  const result: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof mapped !== 'string') {
      throw new Error(`ELISYM_PROVIDER_ACTION_MAP["${key}"] must be a string`);
    }
    result[key] = mapped;
  }
  return result;
}

export interface ReadSource {
  getSetting: (key: string) => string | undefined;
}

function readerFromRuntime(runtime: IAgentRuntime | undefined): ReadSource {
  return {
    getSetting: (key: string) => {
      const fromRuntime = runtime?.getSetting?.(key);
      if (typeof fromRuntime === 'string' && fromRuntime.length > 0) {
        return fromRuntime;
      }
      const fromEnv = process.env[key];
      return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
    },
  };
}

export function validateConfig(
  raw: Record<string, string | undefined>,
  runtime?: IAgentRuntime,
): ElisymConfig {
  const reader = readerFromRuntime(runtime);
  const read = (key: string, fallback?: string): string | undefined => {
    const explicit = raw[key];
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
    const external = reader.getSetting(key);
    if (typeof external === 'string' && external.length > 0) {
      return external;
    }
    return fallback;
  };

  const nostrRaw = read('ELISYM_NOSTR_PRIVATE_KEY');
  const nostrPrivateKeyHex = nostrRaw ? normalizeNostrKey(nostrRaw) : undefined;

  const solanaPrivateKeyBase58 = read('ELISYM_SOLANA_PRIVATE_KEY');
  if (!solanaPrivateKeyBase58) {
    throw new Error('ELISYM_SOLANA_PRIVATE_KEY is required');
  }
  validateSolanaKey(solanaPrivateKeyBase58);

  const network = read('ELISYM_NETWORK', 'devnet');
  const mode = read('ELISYM_MODE', 'customer');

  const maxPerJob = solToLamports(read('ELISYM_MAX_SPEND_PER_JOB_SOL', '0.01') ?? '0.01');
  const maxPerHour = solToLamports(read('ELISYM_MAX_SPEND_PER_HOUR_SOL', '0.1') ?? '0.1');
  const approvalAbove = solToLamports(
    read('ELISYM_REQUIRE_APPROVAL_ABOVE_SOL', '0.005') ?? '0.005',
  );

  const providerCapabilities = parseList(read('ELISYM_PROVIDER_CAPABILITIES'));
  const providerPriceRaw = read('ELISYM_PROVIDER_PRICE_SOL');
  const providerPriceLamports = providerPriceRaw ? solToLamports(providerPriceRaw) : undefined;
  const providerActionMap = parseActionMap(read('ELISYM_PROVIDER_ACTION_MAP'));

  return ElisymConfigSchema.parse({
    nostrPrivateKeyHex,
    solanaPrivateKeyBase58,
    network,
    relays: parseList(read('ELISYM_RELAYS')),
    solanaRpcUrl: read('ELISYM_SOLANA_RPC_URL'),
    mode,
    maxSpendPerJobLamports: maxPerJob,
    maxSpendPerHourLamports: maxPerHour,
    requireApprovalAboveLamports: approvalAbove,
    providerCapabilities,
    providerPriceLamports,
    providerActionMap,
  });
}
