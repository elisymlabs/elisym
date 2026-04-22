/**
 * Zod schemas and types for `~/.elisym/config.yaml`.
 *
 * Split from `./global` so the schemas can be re-exported from the
 * browser-safe `@elisym/sdk` entry point without dragging in `node:fs/promises`
 * (which the loader/writer in `./global` needs).
 */

import { z } from 'zod';

export const SessionSpendLimitEntrySchema = z
  .object({
    chain: z.enum(['solana']),
    token: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/, 'token must be lowercase alphanumeric'),
    mint: z.string().min(1).max(64).optional(),
    amount: z.number().positive().finite(),
  })
  .strict();

export const GlobalConfigSchema = z
  .object({
    session_spend_limits: z.array(SessionSpendLimitEntrySchema).max(16).optional(),
  })
  .strict();

export type SessionSpendLimitEntry = z.infer<typeof SessionSpendLimitEntrySchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
