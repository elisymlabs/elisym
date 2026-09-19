/**
 * Every customer-side store serializes writes to one path, and all four need a
 * row saying so.
 *
 * Each is a read-modify-write: load the whole file, change one entry, write it
 * back. Without the per-path queue two calls that overlap both read the same
 * starting state and the second write erases the first - and MCP tool calls are
 * not serialized against each other, which is the same premise the iroh
 * single-flight rests on. What gets lost is not abstract: a job session that
 * was recorded, a turn count that "must never overstate what the provider
 * holds", a read cursor whose loss resurfaces messages the customer has seen.
 *
 * `contacts` and `customer-history` have had such a row from the start; these
 * two did not, and removing their queue entirely left the package green.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listJobSessions, recordSessionSubmit } from '../src/storage/job-sessions.js';
import { advanceReadCursor, readReadCursors } from '../src/storage/read-cursors.js';

let sandbox: string;
let agentDir: string;
const IDENTITY = 'b'.repeat(64);

function sessionId(index: number): string {
  return `3f2b8c1a-9d4e-4f6a-8b2c-${String(index).padStart(12, '0')}`;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-mcp-concurrency-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('writes to one store that overlap', () => {
  it('all land in the job-session list', async () => {
    const total = 12;

    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        recordSessionSubmit(
          { agentDir, identityPubkey: IDENTITY },
          {
            sessionId: sessionId(index),
            providerPubkey: 'a'.repeat(64),
            capability: 'text-gen',
            firstPrompt: 'hello',
            jobEventId: 'e'.repeat(64),
          },
        ),
      ),
    );

    expect(await listJobSessions({ agentDir, identityPubkey: IDENTITY }, 100)).toHaveLength(total);
  });

  it('all land in the DM read cursors', async () => {
    const counterparts = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(2, '0')}${'c'.repeat(62)}`,
    );

    await Promise.all(
      counterparts.map((pubkey, index) =>
        advanceReadCursor(agentDir, pubkey, 1_700_000_000 + index),
      ),
    );

    expect(Object.keys(await readReadCursors(agentDir))).toHaveLength(counterparts.length);
  });
});
