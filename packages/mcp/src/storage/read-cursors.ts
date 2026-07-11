/**
 * DM read cursors: per-counterpart "read up to" timestamps backing
 * `unread_count` in `list_conversations`. Advanced by `get_messages`,
 * NEVER used as a fetch filter - backdated messages must still be returned.
 *
 * Same MCP-private placement rationale as `contacts.ts`: MCP is the only
 * consumer today. The file maps who the agent talks to, so it is also added
 * to the agent-store gitignore defaults and migrated into existing dirs via
 * `ensureGitignoreHasMessagesEntry` before the first write.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureGitignoreHasMessagesEntry, writeFileAtomic } from '@elisym/sdk/agent-store';
import { z } from 'zod';

export const READ_CURSORS_FILENAME = '.messages-read.json';

const PUBKEY_HEX_REGEX = /^[a-f0-9]{64}$/;

export const ReadCursorsSchema = z.object({
  version: z.literal(1),
  /** counterpart pubkey (64 hex) -> last-read rumor timestamp (secs). */
  cursors: z.record(z.string().regex(PUBKEY_HEX_REGEX), z.number().int().nonnegative()),
});

export type ReadCursors = z.infer<typeof ReadCursorsSchema>;

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const wrapped = next.finally(() => {
    if (writeLocks.get(path) === wrapped) {
      writeLocks.delete(path);
    }
  });
  writeLocks.set(path, wrapped);
  return next;
}

function pathFor(agentDir: string): string {
  return join(agentDir, READ_CURSORS_FILENAME);
}

async function readRaw(path: string): Promise<ReadCursors> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { version: 1, cursors: {} };
  }
  try {
    const result = ReadCursorsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : { version: 1, cursors: {} };
  } catch {
    return { version: 1, cursors: {} };
  }
}

/** Read all cursors. Returns an empty map when missing or corrupt. */
export async function readReadCursors(agentDir: string): Promise<Record<string, number>> {
  const data = await readRaw(pathFor(agentDir));
  return data.cursors;
}

/**
 * Advance one counterpart's cursor to
 * `max(currentCursor, min(maxSurfacedCreatedAt, now))`.
 *
 * The inner clamp defuses sender-controlled future timestamps (the unwrap
 * admits up to 10 minutes of skew - without the clamp a +9m59s stamp would
 * zero `unread_count` for every honest message in the next ten minutes).
 * The outer max keeps the cursor monotonic: `get_messages` accepts an
 * explicit old `since` (paging, history re-reads), and a backwards move
 * would resurrect phantom unreads for messages already surfaced.
 */
export async function advanceReadCursor(
  agentDir: string,
  counterpartPubkey: string,
  maxSurfacedCreatedAt: number,
): Promise<void> {
  // Callers pre-validate both arguments (SDK unwrap rejects non-integer
  // timestamps, resolveCounterpart yields only 64-hex pubkeys), but this
  // module owns a file whose whole map is discarded on one schema-invalid
  // KEY OR VALUE (`safeParse` is all-or-nothing) - never let either reach
  // disk, whatever the caller passes.
  if (
    !PUBKEY_HEX_REGEX.test(counterpartPubkey) ||
    !Number.isInteger(maxSurfacedCreatedAt) ||
    maxSurfacedCreatedAt < 0
  ) {
    return;
  }
  const path = pathFor(agentDir);
  await withLock(path, async () => {
    const data = await readRaw(path);
    const nowSecs = Math.floor(Date.now() / 1000);
    const candidate = Math.min(maxSurfacedCreatedAt, nowSecs);
    const current = data.cursors[counterpartPubkey];
    if (current !== undefined && current >= candidate) {
      return;
    }
    data.cursors[counterpartPubkey] = candidate;
    await ensureGitignoreHasMessagesEntry(dirname(agentDir));
    await writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n', 0o600);
  });
}
