/**
 * One iroh node per agent, however many transfers start at once.
 *
 * `ensureIrohTransport` awaits - it runs the `.gitignore` migration before it
 * creates anything - and MCP tool calls are not serialized against each other.
 * Two `submit_and_pay_job` calls a moment apart therefore both reach the
 * creation with `agent.irohTransport` still empty, and `Iroh.persistent` is
 * opened TWICE on one fs-store: the first takes the store lock, the second
 * waits on it for the life of the process, and the one that loses the
 * assignment race can never be shut down, so the lock is never released.
 *
 * Lives in its own file because it mocks `@elisym/sdk/node`: the real
 * `createIrohTransport` needs the native addon and a writable store, and what
 * is being measured here is HOW MANY TIMES it is called.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let created = 0;

vi.mock('@elisym/sdk/node', () => ({
  createIrohTransport: () => {
    created += 1;
    return { shutdown: async () => undefined };
  },
}));

const { ensureIrohTransport, shutdownIrohTransport } = await import('../src/iroh.js');

let sandbox: string;
let agentDir: string;

beforeEach(() => {
  created = 0;
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-iroh-flight-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
  // An older `.gitignore`, so the migration inside really does some async work
  // rather than returning on the first line - the await is the whole point.
  writeFileSync(join(sandbox, '.elisym', '.gitignore'), '.secrets.json\n', 'utf-8');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('two file transfers that start at the same moment', () => {
  it('open ONE node, not one each', async () => {
    const agent = { agentDir } as never;

    const [first, second] = await Promise.all([
      ensureIrohTransport(agent),
      ensureIrohTransport(agent),
    ]);

    expect(created).toBe(1);
    // And both callers hold the SAME one: a second object here means one of
    // them is holding a node the agent does not know about.
    expect(first).toBe(second);
    await shutdownIrohTransport(agent);
  });

  it('reuse the node a completed transfer left behind', async () => {
    const agent = { agentDir } as never;

    const first = await ensureIrohTransport(agent);
    const second = await ensureIrohTransport(agent);

    expect(created).toBe(1);
    expect(first).toBe(second);
    await shutdownIrohTransport(agent);
  });

  it('let a later transfer build a new node after shutdown', async () => {
    // The pending promise must be CLEARED when it settles, not held forever:
    // otherwise the first transfer of the process is the only one that ever
    // creates anything, and after a shutdown every later transfer is handed a
    // node that is gone.
    const agent = { agentDir } as never;

    await ensureIrohTransport(agent);
    await shutdownIrohTransport(agent);
    await ensureIrohTransport(agent);

    expect(created).toBe(2);
    await shutdownIrohTransport(agent);
  });
});
