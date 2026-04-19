import { resolve } from 'node:path';
import type { IAgentRuntime } from '@elizaos/core';
import bs58 from 'bs58';
import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { logger } from './lib/logger';
import { solToLamports } from './lib/pricing';

const HEX_64 = /^[0-9a-f]{64}$/i;

const modeSchema = z.enum(['customer', 'provider', 'both']);
const networkSchema = z.enum(['devnet', 'mainnet']);
const signerKindSchema = z.enum(['local', 'kms', 'external']);

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

export const ProviderProductSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  capabilities: z.array(z.string().min(1)).min(1),
  priceLamports: z
    .bigint()
    .positive()
    .refine((value) => value <= MAX_SAFE_LAMPORTS, {
      message: `price in lamports must be <= ${MAX_SAFE_LAMPORTS}`,
    }),
});

export type ProviderProduct = z.infer<typeof ProviderProductSchema>;

export const ElisymConfigSchema = z
  .object({
    nostrPrivateKeyHex: z
      .string()
      .regex(HEX_64, 'Nostr private key must be 32-byte hex')
      .optional(),
    solanaPrivateKeyBase58: z.string().min(1).optional(),
    signerKind: signerKindSchema,
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
    providerName: z.string().min(1).max(120).optional(),
    providerDescription: z.string().min(1).max(2000).optional(),
    providerProducts: z.array(ProviderProductSchema).min(1).max(32).optional(),
    providerSkillsDir: z.string().min(1).optional(),
  })
  .refine(
    (cfg) => {
      if (cfg.mode === 'customer') {
        return true;
      }
      if (cfg.providerProducts !== undefined && cfg.providerProducts.length > 0) {
        return true;
      }
      if (cfg.providerSkillsDir !== undefined) {
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
        'Provider mode requires one of: ELISYM_PROVIDER_PRODUCTS (JSON array), ELISYM_PROVIDER_SKILLS_DIR, or both ELISYM_PROVIDER_CAPABILITIES and ELISYM_PROVIDER_PRICE_SOL',
    },
  )
  .refine(
    (cfg) => {
      if (cfg.signerKind === 'local') {
        return true;
      }
      return cfg.solanaPrivateKeyBase58 === undefined;
    },
    {
      message:
        'ELISYM_SIGNER_KIND must be "local" when ELISYM_SOLANA_PRIVATE_KEY is set; ' +
        'remove the key from config to use an external signer.',
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

/* cspell:disable */
const SECRET_SALT_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'replaceme',
  'replace-me',
  'replace_me',
  'placeholder',
  'example',
  'default',
  'test',
  'dev',
  'development',
  '0',
  '0000000000000000',
]);
/* cspell:enable */

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || SECRET_SALT_PLACEHOLDERS.has(normalized);
}

let unsecuredRuntimeWarned = false;
let legacyProviderEnvWarned = false;

const LEGACY_PROVIDER_ENV_KEYS = [
  'ELISYM_PROVIDER_CAPABILITIES',
  'ELISYM_PROVIDER_PRICE_SOL',
  'ELISYM_PROVIDER_NAME',
  'ELISYM_PROVIDER_DESCRIPTION',
] as const;

interface LegacyProviderInput {
  capabilities: string[] | undefined;
  priceLamports: bigint | undefined;
  name: string | undefined;
  description: string | undefined;
  hasProducts: boolean;
}

export function checkLegacyProviderEnv(input: LegacyProviderInput): void {
  const usedLegacy = LEGACY_PROVIDER_ENV_KEYS.filter((key) => {
    if (key === 'ELISYM_PROVIDER_CAPABILITIES') {
      return input.capabilities !== undefined;
    }
    if (key === 'ELISYM_PROVIDER_PRICE_SOL') {
      return input.priceLamports !== undefined;
    }
    if (key === 'ELISYM_PROVIDER_NAME') {
      return input.name !== undefined;
    }
    return input.description !== undefined;
  });
  if (usedLegacy.length === 0) {
    return;
  }
  if (input.hasProducts) {
    throw new Error(
      `ELISYM_PROVIDER_PRODUCTS conflicts with the legacy single-product vars (${usedLegacy.join(', ')}). ` +
        'Pick one configuration shape; the legacy vars are removed in 0.4.0.',
    );
  }
  if (!legacyProviderEnvWarned) {
    logger.warn(
      { usedLegacy },
      'using deprecated single-product provider vars; migrate to ELISYM_PROVIDER_PRODUCTS before 0.4.0',
    );
    legacyProviderEnvWarned = true;
  }
}

interface ServerHardeningInput {
  network: string | undefined;
  mode: string | undefined;
  hasProviderSecret: boolean;
  secretSalt: string | undefined;
  authToken: string | undefined;
  allowUnsecured: string | undefined;
}

export function enforceServerHardening(input: ServerHardeningInput): void {
  const isMainnet = input.network === 'mainnet';
  const isProvider = input.mode === 'provider' || input.mode === 'both';
  const requiresHardening = isMainnet || (isProvider && input.hasProviderSecret);
  if (!requiresHardening) {
    return;
  }
  const missing: string[] = [];
  if (!input.secretSalt || isPlaceholderValue(input.secretSalt)) {
    missing.push('SECRET_SALT');
  }
  if (!input.authToken || isPlaceholderValue(input.authToken)) {
    missing.push('ELIZA_SERVER_AUTH_TOKEN');
  }
  if (missing.length === 0) {
    return;
  }
  const allowUnsecured = (input.allowUnsecured ?? '').trim().toLowerCase() === 'true';
  if (allowUnsecured) {
    if (!unsecuredRuntimeWarned) {
      logger.warn(
        { missing, network: input.network, mode: input.mode },
        'ELISYM_ALLOW_UNSECURED_RUNTIME=true is set; running without ' +
          missing.join(' / ') +
          '. Encryption-at-rest and HTTP authentication are effectively disabled - dev only.',
      );
      unsecuredRuntimeWarned = true;
    }
    return;
  }
  throw new Error(
    `Refusing to start: ${missing.join(' / ')} must be set to a non-default value when ` +
      'running on mainnet or as a provider with a configured secret key. ' +
      'Set the env var(s), or pass ELISYM_ALLOW_UNSECURED_RUNTIME=true for local dev.',
  );
}

function parseProducts(value: string | undefined): ProviderProduct[] | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ELISYM_PROVIDER_PRODUCTS is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ELISYM_PROVIDER_PRODUCTS must be a JSON array of products');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`ELISYM_PROVIDER_PRODUCTS[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const priceSol = obj.priceSol ?? obj.price_sol;
    if (typeof priceSol !== 'string' || priceSol.length === 0) {
      throw new Error(
        `ELISYM_PROVIDER_PRODUCTS[${index}].priceSol must be a non-empty string (SOL amount)`,
      );
    }
    return ProviderProductSchema.parse({
      name: obj.name,
      description: obj.description,
      capabilities: obj.capabilities,
      priceLamports: solToLamports(priceSol),
    });
  });
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
  if (solanaPrivateKeyBase58) {
    validateSolanaKey(solanaPrivateKeyBase58);
  }

  const network = read('ELISYM_NETWORK', 'devnet');
  const mode = read('ELISYM_MODE', 'customer');
  const signerKind = read('ELISYM_SIGNER_KIND', 'local');

  const maxPerJob = solToLamports(read('ELISYM_MAX_SPEND_PER_JOB_SOL', '0.01') ?? '0.01');
  const maxPerHour = solToLamports(read('ELISYM_MAX_SPEND_PER_HOUR_SOL', '0.1') ?? '0.1');
  const approvalAbove = solToLamports(
    read('ELISYM_REQUIRE_APPROVAL_ABOVE_SOL', '0.005') ?? '0.005',
  );

  const providerCapabilities = parseList(read('ELISYM_PROVIDER_CAPABILITIES'));
  const providerPriceRaw = read('ELISYM_PROVIDER_PRICE_SOL');
  const providerPriceLamports = providerPriceRaw ? solToLamports(providerPriceRaw) : undefined;
  const providerActionMap = parseActionMap(read('ELISYM_PROVIDER_ACTION_MAP'));
  const providerName = read('ELISYM_PROVIDER_NAME');
  const providerDescription = read('ELISYM_PROVIDER_DESCRIPTION');
  const providerProducts = parseProducts(read('ELISYM_PROVIDER_PRODUCTS'));
  const providerSkillsDirRaw = read('ELISYM_PROVIDER_SKILLS_DIR');
  const providerSkillsDir = providerSkillsDirRaw ? resolve(providerSkillsDirRaw) : undefined;

  checkLegacyProviderEnv({
    capabilities: providerCapabilities,
    priceLamports: providerPriceLamports,
    name: providerName,
    description: providerDescription,
    hasProducts: providerProducts !== undefined,
  });

  enforceServerHardening({
    network,
    mode,
    hasProviderSecret: solanaPrivateKeyBase58 !== undefined,
    secretSalt: reader.getSetting('SECRET_SALT'),
    authToken: reader.getSetting('ELIZA_SERVER_AUTH_TOKEN'),
    allowUnsecured: reader.getSetting('ELISYM_ALLOW_UNSECURED_RUNTIME'),
  });

  return ElisymConfigSchema.parse({
    nostrPrivateKeyHex,
    solanaPrivateKeyBase58,
    signerKind,
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
    providerName,
    providerDescription,
    providerProducts,
    providerSkillsDir,
  });
}
