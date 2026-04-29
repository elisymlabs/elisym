/**
 * Zod schemas for elisym.yaml (public source of truth) and secrets.json (private).
 * Shared between CLI (provider mode) and MCP (customer mode, future provider mode).
 */

import { z } from 'zod';
import { LIMITS } from '../constants';

const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const AgentNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.MAX_AGENT_NAME_LENGTH)
  .regex(AGENT_NAME_PATTERN, 'alphanumeric, underscore, or hyphen only');

/**
 * Agent wallet entry. One entry per (chain, network) - the address receives
 * every asset on that chain (SOL directly, SPL tokens via their ATA derived
 * from (address, mint)). Per-asset pricing lives in each skill's `SKILL.md`;
 * the canonical mint registry lives in `KNOWN_ASSETS` (payment/assets.ts).
 */
export const PaymentSchema = z.object({
  chain: z.literal('solana'),
  network: z.enum(['devnet']),
  address: z.string().min(1),
});

export const LlmSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  max_tokens: z.number().int().positive().max(200_000).default(4096),
});

export const SecurityFlagsSchema = z.object({
  withdrawals_enabled: z.boolean().default(false),
  agent_switch_enabled: z.boolean().default(false),
});

/**
 * elisym.yaml schema. Public - committed to git.
 * Agent name NOT stored here - derived from containing folder name.
 *
 * The top-level field list is mirrored in `skills/elisym-config/SKILL.md`
 * so the elisym-config agent skill can patch this file directly. Drift
 * is guarded by `packages/sdk/tests/config-skill-drift.test.ts` - when
 * you add or remove a top-level field here, update that SKILL.md too.
 */
export const ElisymYamlSchema = z
  .object({
    /** Human-readable name shown in UI (optional). Falls back to folder name. */
    display_name: z.string().max(LIMITS.MAX_AGENT_NAME_LENGTH).optional(),
    description: z.string().max(LIMITS.MAX_DESCRIPTION_LENGTH).default(''),
    /** Relative path (to this YAML) or absolute URL. */
    picture: z.string().optional(),
    /** Relative path (to this YAML) or absolute URL. */
    banner: z.string().optional(),
    relays: z.array(z.string().url()).default([]),
    payments: z.array(PaymentSchema).default([]),
    llm: LlmSchema.optional(),
    security: SecurityFlagsSchema.partial().default({}),
  })
  .strict();

export type ElisymYaml = z.infer<typeof ElisymYamlSchema>;
export type PaymentEntry = z.infer<typeof PaymentSchema>;
export type LlmEntry = z.infer<typeof LlmSchema>;
export type SecurityFlags = z.infer<typeof SecurityFlagsSchema>;

/**
 * secrets.json schema. Private - .gitignore.
 * Values may be plaintext or `encrypted:v1:...` blobs (AES-256-GCM + scrypt).
 *
 * `llm_api_keys` is a generic record keyed by provider id (e.g. `anthropic`,
 * `openai`, future `xai`/`google`/...). Adding a new LLM provider does not
 * require a schema change. Each value is a separate ciphertext blob when
 * encrypted.
 */
export const SecretsSchema = z
  .object({
    nostr_secret_key: z.string().min(1),
    solana_secret_key: z.string().optional(),
    /** Per-provider LLM API keys, keyed by descriptor id (e.g. `anthropic`, `openai`). */
    llm_api_keys: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type Secrets = z.infer<typeof SecretsSchema>;

export interface MediaCacheEntry {
  url: string;
  sha256: string;
  uploaded_at: string;
}

export const MediaCacheEntrySchema: z.ZodType<MediaCacheEntry> = z
  .object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    uploaded_at: z.string(),
  })
  .strict();

export const MediaCacheSchema = z.record(z.string(), MediaCacheEntrySchema);

export type MediaCache = z.infer<typeof MediaCacheSchema>;
