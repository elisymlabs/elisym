/**
 * One failed write must not jam every later write to the same file.
 *
 * These stores serialize per path through a promise chain, and what keeps the
 * chain alive is that the promise stored in the queue absorbs rejection: the
 * next caller chains onto something that runs. Without it the queue stays
 * rejected for the life of the process - the customer history stops recording,
 * the contact list stops accepting, and nothing says why - which is the same
 * outcome the blocking-node gate exists to prevent, reached from the other
 * side. Two independent mechanisms hold that open - the absorbed queue entry
 * and the `then(fn, fn)` beside it - and either alone suffices, so neither line
 * can be killed on its own. The row below therefore pins the OUTCOME; the row
 * above it pins the one consequence that does separate them.
 *
 * Both writes are started in the SAME tick on purpose: the second has to
 * attach to the first one's queue entry before it settles, which is the only
 * arrangement where the difference shows.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make the NEXT atomic write fail, once. */
let failNextWrite: Error | null = null;

vi.mock('@elisym/sdk/agent-store', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@elisym/sdk/agent-store');
  return {
    ...actual,
    writeFileAtomic: async (path: string, data: string, mode: number) => {
      if (failNextWrite) {
        const failure = failNextWrite;
        failNextWrite = null;
        throw failure;
      }
      return actual.writeFileAtomic(path, data, mode);
    },
  };
});

const { appendCustomerJob, readCustomerHistory } =
  await import('../src/storage/customer-history.js');

let sandbox: string;
let agentDir: string;

function job(id: string) {
  return {
    jobEventId: id.repeat(64).slice(0, 64),
    capability: 'text-gen',
    providerPubkey: 'a'.repeat(64),
    status: 'completed' as const,
    submittedAt: 1,
    completedAt: 2,
  };
}

beforeEach(() => {
  failNextWrite = null;
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-mcp-queue-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  failNextWrite = null;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('a write that fails while another is queued behind it', () => {
  it('leaves no rejection nobody is waiting on', async () => {
    // What the absorption on the stored promise actually buys, and the only
    // half of it a test can separate: `finally` re-throws, so the queue entry
    // rejects even when the caller handled its own promise. In the MCP server
    // that is logged and survived; anywhere without such a listener Node ends
    // the process. The queue-recovery row below cannot see this - two
    // independent mechanisms keep the queue alive and either alone suffices -
    // so the detached rejection is what gets measured instead.
    const detached: unknown[] = [];
    const record = (reason: unknown) => {
      detached.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      failNextWrite = new Error('ENOSPC: no space left on device, write');
      await expect(appendCustomerJob(agentDir, job('e'))).rejects.toThrow(/ENOSPC/);
      // Two turns: an unhandled rejection is reported after the microtask
      // queue drains, not at the moment of rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(detached).toEqual([]);
  });

  it('does not take the queued one down with it', async () => {
    failNextWrite = new Error('ENOSPC: no space left on device, write');

    const first = appendCustomerJob(agentDir, job('e'));
    const second = appendCustomerJob(agentDir, job('f'));

    await expect(first).rejects.toThrow(/ENOSPC/);
    await expect(second).resolves.toBeUndefined();

    // And the survivor is on disk, which is what "the queue recovered" has to
    // mean - not merely that the promise settled.
    expect((await readCustomerHistory(agentDir)).jobs).toHaveLength(1);
  });
});
