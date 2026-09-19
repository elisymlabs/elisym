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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let created = 0;
let shutdowns = 0;

vi.mock('@elisym/sdk/node', () => ({
  createIrohTransport: () => {
    created += 1;
    return {
      shutdown: async () => {
        shutdowns += 1;
      },
    };
  },
}));

const { ensureIrohTransport, shutdownIrohTransport } = await import('../src/iroh.js');
const { scrubAgent } = await import('../src/tools/agent.js');
const { teardownRegistry } = await import('../src/server.js');

let sandbox: string;
let agentDir: string;

beforeEach(() => {
  created = 0;
  shutdowns = 0;
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

  it('are shut down even when the transfer that opened them is still starting', async () => {
    // `shutdownIrohTransport` sees `agent.irohTransport` only once creation has
    // finished, and creation awaits. A teardown that lands in that window would
    // otherwise walk away from a node that is about to exist - holding the
    // store lock, with nothing left referencing it - so the shutdown waits for
    // the pending creation first.
    //
    // Not a process-teardown-only concern, which is what makes it a race and
    // not tidiness: `scrubAgent` calls this from `switch_agent` and
    // `stop_agent`, ordinary tool calls that are not serialized against the
    // file transfer they interrupt. The agent is then dropped from the registry
    // while a node is still attaching to `<agentDir>/.iroh`, so the store lock
    // is held by something unreachable and switching back opens a second node
    // on the same store - the exact failure the single-flight above prevents,
    // reached through the other door.
    const agent = { agentDir } as never;

    const starting = ensureIrohTransport(agent);
    await shutdownIrohTransport(agent);

    await starting;
    expect(created).toBe(1);
    expect(shutdowns).toBe(1);
    // And nothing is left attached to the agent that was just torn down.
    expect((agent as { irohTransport?: unknown }).irohTransport).toBeUndefined();
  });

  it('are refused outright once the agent has been scrubbed', async () => {
    // The mirror image of the row above, and the one the single-flight cannot
    // help with: here the teardown finishes FIRST, and a handler that captured
    // this agent before `switch_agent` arrived comes asking afterwards. The
    // agent is out of the registry by then, so a node opened for it would hold
    // the store lock with nothing left to shut it down - and switching back
    // would open a second node on the same store.
    const agent = { agentDir, scrubbed: true } as never;

    // A REJECTED promise, not a synchronous throw: callers written as
    // `ensureIrohTransport(a).catch(...)` exist, and a sync throw walks past
    // them.
    await expect(ensureIrohTransport(agent)).rejects.toThrow(/stopped/);
    expect(created).toBe(0);
  });

  it('are refused from the moment a scrub STARTS, not from the moment it ends', async () => {
    // The ordering is the whole guard: the handler being raced is already
    // running, and everything `scrubAgent` does is asynchronous, so a flag set
    // after its awaits protects nothing. This asks WHILE the scrub is still in
    // flight - move the assignment below the first await and the transport is
    // created here instead of refused.
    const agent = {
      name: 'alice',
      agentDir,
      client: { close: () => undefined },
      identity: { scrub: () => undefined },
    } as { name: string; agentDir: string; scrubbed?: boolean };
    const registry = new Map<string, unknown>([['alice', agent]]);

    const scrubbing = scrubAgent({ registry } as never, agent as never);
    const refused = expect(ensureIrohTransport(agent as never)).rejects.toThrow(/stopped/);

    await refused;
    await scrubbing;
    expect(created).toBe(0);
    expect(registry.has('alice')).toBe(false);
  });

  it('are refused for EVERY agent the server is shutting down, not one at a time', async () => {
    // Driven through the REAL teardown, not through the helper it calls: a
    // fixture on the helper alone measures the helper, so deleting its one call
    // from the server would be silent - which is how this door was left open
    // once already.
    //
    // The first agent's teardown is held mid-flight and the second is asked
    // WHILE it is held. Mark inside the loop instead of ahead of it and the
    // second is still unmarked at that moment, so a transport opens for an
    // agent the server is in the middle of dropping - and for an ephemeral one
    // that is worse than a held lock, because `shutdownIrohTransport` has
    // already forgotten the tmpdir holding job inputs and bought results in the
    // clear.
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<never>((_resolve, reject) => {
      releaseFirst = () => reject(new Error('first agent torn down'));
    });
    held.catch(() => undefined);
    const first = {
      name: 'alice',
      agentDir,
      irohTransportPending: held,
      client: { close: () => undefined },
      identity: { scrub: () => undefined },
    };
    const second = {
      name: 'bob',
      agentDir,
      client: { close: () => undefined },
      identity: { scrub: () => undefined },
    } as { name: string; scrubbed?: boolean };
    const registry = new Map<string, unknown>([
      ['alice', first],
      ['bob', second],
    ]);

    const tearing = teardownRegistry({ registry } as never);
    const refused = expect(ensureIrohTransport(second as never)).rejects.toThrow(/stopped/);

    releaseFirst();
    await refused;
    await tearing;
    expect(created).toBe(0);
  });

  it('do not hold a teardown hostage when the node never finishes opening', async () => {
    // `Iroh.persistent` blocks on the store's own lock, and a lock left by a
    // previous crash is exactly what this teardown exists to clear - so the
    // creation being waited on may never return. Unbounded, that wait turned
    // `switch_agent`, `stop_agent` and SIGINT into hangs: the shutdown loop is
    // serial, so every later agent kept its key bytes in memory, and a second
    // SIGINT is swallowed by the shutting-down flag. Measured before the bound
    // went in.
    const neverSettles = new Promise<never>(() => undefined);
    const agent = {
      name: 'alice',
      agentDir,
      irohTransportPending: neverSettles,
      irohStoreDir: join(sandbox, 'ephemeral-store'),
    } as never;
    mkdirSync(join(sandbox, 'ephemeral-store'), { recursive: true });

    // Raced HERE rather than left to the harness clock: unbounded, this call
    // never returns, and a row that dies on the test timeout reports a hang
    // instead of the sentence that says what broke.
    const outcome = await Promise.race([
      shutdownIrohTransport(agent, 20).then(() => 'returned'),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('hung'), 500).unref?.();
      }),
    ]);

    expect(outcome).toBe('returned');
    // And the ephemeral store is gone: giving up on the pending node must not
    // skip the cleanup this teardown exists for.
    expect(existsSync(join(sandbox, 'ephemeral-store'))).toBe(false);
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
