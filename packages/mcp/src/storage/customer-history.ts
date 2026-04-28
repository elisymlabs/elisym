/**
 * Customer-side job history: a per-agent local cache of jobs the user has
 * submitted via this MCP. Distinct from `.jobs.json` (the CLI provider-mode
 * recovery ledger). Written when a job completes (or fails/times out) so
 * `list_my_jobs` can show history even after Nostr relays expire the
 * underlying events.
 *
 * Lives in `packages/mcp/src/storage/` rather than the SDK because today
 * MCP is the only consumer. If a second consumer appears (ElizaOS plugin,
 * future web-app server, etc.), promote this module into `@elisym/sdk/agent-store`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@elisym/sdk/agent-store';
import { z } from 'zod';

export const CUSTOMER_HISTORY_FILENAME = '.customer-history.json';
export const MAX_HISTORY_ENTRIES = 500;

const StatusSchema = z.enum(['completed', 'failed', 'timeout']);
const FeedbackSchema = z.enum(['positive', 'negative']);

export const CustomerJobEntrySchema = z
  .object({
    jobEventId: z.string().min(1).max(128),
    capability: z.string().min(1).max(200),
    providerPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    providerName: z.string().max(200).optional(),
    paidAmountSubunits: z.string().max(40).optional(),
    assetKey: z.string().max(80).optional(),
    status: StatusSchema,
    submittedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    resultPreview: z.string().max(500).optional(),
    paymentSig: z.string().max(128).optional(),
    customerFeedback: FeedbackSchema.optional(),
  })
  .strict();

export const CustomerHistorySchema = z
  .object({
    version: z.literal(1),
    jobs: z.array(CustomerJobEntrySchema),
  })
  .strict();

export type CustomerJobEntry = z.infer<typeof CustomerJobEntrySchema>;
export type CustomerHistory = z.infer<typeof CustomerHistorySchema>;

const EMPTY: CustomerHistory = { version: 1, jobs: [] };

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeLocks.set(
    path,
    next.finally(() => {
      if (writeLocks.get(path) === next) {
        writeLocks.delete(path);
      }
    }),
  );
  return next;
}

function pathFor(agentDir: string): string {
  return join(agentDir, CUSTOMER_HISTORY_FILENAME);
}

async function readRaw(path: string): Promise<CustomerHistory> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { ...EMPTY, jobs: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const result = CustomerHistorySchema.safeParse(parsed);
    return result.success ? result.data : { ...EMPTY, jobs: [] };
  } catch {
    return { ...EMPTY, jobs: [] };
  }
}

async function writeRaw(path: string, history: CustomerHistory): Promise<void> {
  const body = JSON.stringify(history, null, 2) + '\n';
  await writeFileAtomic(path, body, 0o600);
}

/** Read .customer-history.json. Returns an empty history if missing or corrupt. */
export async function readCustomerHistory(agentDir: string): Promise<CustomerHistory> {
  return readRaw(pathFor(agentDir));
}

/**
 * Append a new job entry. Idempotent on `jobEventId`: a second call with the
 * same id replaces the existing entry (same-position) instead of duplicating.
 * Trims oldest entries by `submittedAt` once the count exceeds MAX_HISTORY_ENTRIES.
 */
export async function appendCustomerJob(agentDir: string, entry: CustomerJobEntry): Promise<void> {
  // Validate before write. readRaw rejects the WHOLE document when any entry
  // fails safeParse, so an oversized field (e.g. an untrusted provider.name
  // from a remote kind:0 event) would silently wipe history on next read.
  const validated = CustomerJobEntrySchema.parse(entry);
  const path = pathFor(agentDir);
  return withLock(path, async () => {
    const history = await readRaw(path);
    const existingIndex = history.jobs.findIndex((job) => job.jobEventId === validated.jobEventId);
    if (existingIndex >= 0) {
      history.jobs[existingIndex] = validated;
    } else {
      history.jobs.push(validated);
    }
    if (history.jobs.length > MAX_HISTORY_ENTRIES) {
      history.jobs.sort((left, right) => left.submittedAt - right.submittedAt);
      history.jobs.splice(0, history.jobs.length - MAX_HISTORY_ENTRIES);
    }
    await writeRaw(path, history);
  });
}

/**
 * Patch fields on an existing entry. No-op if the entry does not exist.
 * Does NOT trim - trimming only happens on append, otherwise an update could
 * delete a record that submit_feedback just looked up.
 */
export async function updateCustomerJob(
  agentDir: string,
  jobEventId: string,
  patch: Partial<CustomerJobEntry>,
): Promise<void> {
  const path = pathFor(agentDir);
  return withLock(path, async () => {
    const history = await readRaw(path);
    const index = history.jobs.findIndex((job) => job.jobEventId === jobEventId);
    if (index < 0) {
      return;
    }
    const merged = CustomerJobEntrySchema.parse({ ...history.jobs[index], ...patch });
    history.jobs[index] = merged;
    await writeRaw(path, history);
  });
}

/** Find a single job by its event id. */
export async function findCustomerJob(
  agentDir: string,
  jobEventId: string,
): Promise<CustomerJobEntry | undefined> {
  const history = await readCustomerHistory(agentDir);
  return history.jobs.find((job) => job.jobEventId === jobEventId);
}

/**
 * All entries for a given provider pubkey, newest first (by completedAt).
 * Used by add_contact to enrich a newly added contact with last-job metadata.
 */
export async function findCustomerJobsByProvider(
  agentDir: string,
  providerPubkey: string,
): Promise<CustomerJobEntry[]> {
  const history = await readCustomerHistory(agentDir);
  return history.jobs
    .filter((job) => job.providerPubkey === providerPubkey)
    .sort((left, right) => right.completedAt - left.completedAt);
}
