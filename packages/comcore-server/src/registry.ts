import { HEX_PUBKEY_RE } from '@elisym/commerce';
import { hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import type { StoreRecord } from './state/types';

const HEX_SECRET_RE = /^[0-9a-f]{64}$/;

const StoreEntrySchema = z.object({
  owner: z.string().regex(HEX_PUBKEY_RE),
  status: z.enum(['pending', 'active', 'suspended']),
  assistantSecretKey: z.string().regex(HEX_SECRET_RE),
  tier: z.object({
    messagesPerSessionPerDay: z.number().int().positive(),
    dailyBudgetUsd: z.string().regex(/^\d{1,9}(\.\d{1,9})?$/),
    ticketsPerStorePerMinute: z.number().int().positive(),
    branding: z.boolean(),
  }),
});

/**
 * Phase 2's store registry: a JSON list of stores with their assistant keys
 * and tiers. Phase 3 replaces it with the database (stores, keys encrypted at
 * rest, operator CLI).
 */
export function parseStoreRegistry(text: string): StoreRecord[] {
  return z
    .array(StoreEntrySchema)
    .parse(JSON.parse(text))
    .map((entry) => ({
      owner: entry.owner,
      status: entry.status,
      assistantSecretKey: hexToBytes(entry.assistantSecretKey),
      tier: entry.tier,
    }));
}
