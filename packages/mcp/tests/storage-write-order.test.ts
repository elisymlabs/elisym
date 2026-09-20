/**
 * The `.gitignore` migration runs BEFORE the write, not merely alongside it.
 *
 * All FOUR customer-side stores, because all four widened their entry on this
 * branch - `.contacts.json*`, `.customer-history.json*`, `.job-sessions.json*`
 * and `.messages-read.json*` - so on an older agent every one of them faces a
 * `.gitignore` carrying the bare name.
 *
 * These files are written through `${path}.tmp.${hex}` and renamed. A write
 * that dies in between leaves the temporary on disk, and only an entry that is
 * ALREADY in the `.gitignore` covers it - an agent created by an older build
 * carries the bare name, which cannot match a random suffix. So the order is
 * the guard, not the call.
 *
 * Watched rather than forced. Making the write fail would measure the same
 * thing, but these stores serialize through a per-path promise queue, and a
 * rejection that reaches the stored promise is one nobody is waiting on - noise
 * that a fixture should not have to create. (An earlier round claimed such a
 * suite could report a false PASS; that was wrong - vitest fails the run - but
 * watching is still the cleaner instrument.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every migration and write call, in the order they were made. */
let calls: string[] = [];

vi.mock('@elisym/sdk/agent-store', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@elisym/sdk/agent-store');
  return {
    ...actual,
    ensureGitignoreHasPrivateStateEntries: async (root: string) => {
      calls.push('migration');
      return actual.ensureGitignoreHasPrivateStateEntries(root);
    },
    ensureGitignoreHasJobSessionsEntry: async (root: string) => {
      calls.push('migration');
      return actual.ensureGitignoreHasJobSessionsEntry(root);
    },
    ensureGitignoreHasMessagesEntry: async (root: string) => {
      calls.push('migration');
      return actual.ensureGitignoreHasMessagesEntry(root);
    },
    writeFileAtomic: async (path: string, data: string, mode: number) => {
      calls.push('write');
      return actual.writeFileAtomic(path, data, mode);
    },
  };
});

const { upsertContact } = await import('../src/storage/contacts.js');
const { appendCustomerJob } = await import('../src/storage/customer-history.js');
const { recordSessionSubmit } = await import('../src/storage/job-sessions.js');
const { advanceReadCursor } = await import('../src/storage/read-cursors.js');

let sandbox: string;
let agentDir: string;

beforeEach(() => {
  calls = [];
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-mcp-order-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(sandbox, '.elisym', '.gitignore'), '.secrets.json\n', 'utf-8');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('a customer-side store writing to an older agent directory', () => {
  it.each([
    [
      'the contact list',
      async (dir: string) => {
        await upsertContact(dir, { pubkey: 'a'.repeat(64), npub: 'npub1bob' });
      },
    ],
    [
      'the customer history',
      async (dir: string) => {
        await appendCustomerJob(dir, {
          jobEventId: 'e'.repeat(64),
          capability: 'text-gen',
          providerPubkey: 'a'.repeat(64),
          status: 'completed',
          submittedAt: 1,
          completedAt: 2,
        });
      },
    ],
    [
      'the job-session list',
      async (dir: string) => {
        await recordSessionSubmit(
          { agentDir: dir, identityPubkey: 'b'.repeat(64) },
          {
            sessionId: '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c',
            providerPubkey: 'a'.repeat(64),
            capability: 'text-gen',
            firstPrompt: 'hello',
            jobEventId: 'e'.repeat(64),
          },
        );
      },
    ],
    [
      'the DM read cursors',
      async (dir: string) => {
        await advanceReadCursor(dir, 'b'.repeat(64), 42);
      },
    ],
  ])('widens the .gitignore before %s reaches disk', async (_label, write) => {
    await write(agentDir);

    expect(calls).toEqual(['migration', 'write']);
  });
});
