/**
 * Per-agent iroh blob transport lifecycle for the MCP customer.
 *
 * The transport is created lazily on the first file transfer and held on the
 * `AgentInstance` for the life of the (long-lived) MCP server process. An
 * identity-backed agent stores blobs at `<agentDir>/.iroh/`; an ephemeral agent
 * (no `agentDir`) uses an `os.tmpdir()` store removed on shutdown. Both are
 * fs-stores (stream to disk, no whole-file buffering).
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureGitignoreHasIrohEntry } from '@elisym/sdk/agent-store';
import { createIrohTransport, type IrohBlobTransport } from '@elisym/sdk/node';
import type { AgentInstance } from './context';

/**
 * Get (creating on first use) the agent's iroh transport.
 *
 * SINGLE-FLIGHT, and not as an optimization: this function awaits (the
 * `.gitignore` migration below), and MCP tool calls are not serialized against
 * each other. Two file transfers a moment apart would otherwise both see an
 * empty `agent.irohTransport`, both pass the await, and both call
 * `createIrohTransport` - two `Iroh.persistent` nodes on ONE fs-store. The
 * first takes the store lock; the second waits on it for the life of the
 * process, and whichever loses the assignment race is unreachable from
 * `shutdownIrohTransport`, so the lock is never released either. The pending
 * promise is therefore recorded BEFORE the first await, which is the whole
 * trick: everything async happens inside it.
 */
export async function ensureIrohTransport(agent: AgentInstance): Promise<IrohBlobTransport> {
  // A scrubbed agent is gone from the registry, so nothing would ever shut this
  // down again: `server.ts`'s teardown walks the registry. The single-flight
  // below closes the window where a teardown OVERTAKES a creation; this closes
  // the mirror image, where a handler that captured its agent before the scrub
  // arrives after it. Refusing is right either way - the caller's agent is not
  // the one serving requests any more.
  if (agent.scrubbed) {
    throw new Error(`Agent ${agent.name} has been stopped; not opening a file transport for it`);
  }
  if (agent.irohTransport) {
    return agent.irohTransport;
  }
  // `async` on the signature, and the assignment below still happens before any
  // await inside `createTransport` - the single-flight survives. What `async`
  // buys is that the refusal above arrives as a REJECTED PROMISE rather than a
  // synchronous throw. Every PRODUCTION caller awaits inside a `try`, so
  // nothing is broken either way; the point is that the two forms must not
  // disagree, because `.catch()` on this call is a shape a caller may write.
  agent.irohTransportPending ??= createTransport(agent).finally(() => {
    agent.irohTransportPending = undefined;
  });
  return agent.irohTransportPending;
}

async function createTransport(agent: AgentInstance): Promise<IrohBlobTransport> {
  let storePath: string;
  if (agent.agentDir !== undefined) {
    storePath = join(agent.agentDir, '.iroh');
    // The same argument as the four stores beside this one: nothing else in an
    // MCP process runs this migration, and an agent used only as a customer
    // never runs `elisym start`, which is the only other caller. What the store
    // holds is job inputs and bought results in the CLEAR, so a project-local
    // agent inside somebody's repository would commit them.
    await ensureGitignoreHasIrohEntry(dirname(agent.agentDir));
  } else {
    // Ephemeral agent: a tmpdir store, removed on shutdown.
    storePath = mkdtempSync(join(tmpdir(), 'elisym-iroh-'));
    agent.irohStoreDir = storePath;
  }
  agent.irohTransport = createIrohTransport({ storePath });
  return agent.irohTransport;
}

/**
 * Mark every agent as torn down, in one pass, before any of them is shut down.
 *
 * The server's own shutdown loop awaits per agent, so marking inside it would
 * leave each later agent unguarded for the whole of the previous one's
 * teardown - and `scrubAgent` covers only the one agent a `switch_agent` or
 * `stop_agent` is retiring. Lives here, beside the flag's meaning, so the two
 * teardown paths cannot drift. Driven through `teardownRegistry`, which a
 * fixture calls directly, so both the missing call and a mark moved inside the
 * loop redden.
 */
export function markAgentsScrubbed(agents: Iterable<AgentInstance>): void {
  for (const agent of agents) {
    agent.scrubbed = true;
  }
}

/**
 * How long a teardown waits for a creation that is still in flight.
 *
 * BOUNDED, because this teardown must finish even when the creation it is
 * waiting on does not. Waiting forever turned `switch_agent`, `stop_agent` and
 * SIGINT into hangs, with the second SIGINT swallowed by the shutting-down flag
 * and only SIGKILL left - measured with a creation that never settles.
 *
 * What could hold it is not settled either way, and the honest version is: the
 * transport is built lazily, so `Iroh.persistent` opens later in `getNode`
 * rather than inside this promise, and the one await in `createTransport` is
 * the `.gitignore` migration, itself gated against a blocking node. So the
 * bound guards a shape the code does not obviously reach today - and costs one
 * timer to keep a server that only SIGKILL can stop impossible tomorrow.
 */
const PENDING_TEARDOWN_WAIT_MS = 5_000;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // `unref` so a teardown that finished early is not held open by this timer.
    setTimeout(resolve, ms).unref?.();
  });
}

/** Shut down the agent's iroh node (release the fs-lock) and clean an ephemeral store. */
export async function shutdownIrohTransport(
  agent: AgentInstance,
  pendingWaitMs = PENDING_TEARDOWN_WAIT_MS,
): Promise<void> {
  // The PENDING one too: a shutdown that races a first file transfer would
  // otherwise leave a node holding the store lock with nothing referencing it.
  // Bounded, per the constant above, and if the node turns up after we stopped
  // waiting it is closed then - late is better than never for a store lock.
  const pending = agent.irohTransportPending;
  if (pending) {
    let settled = false;
    const observed = pending.then(
      (transport) => {
        settled = true;
        return transport;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await Promise.race([observed, waitMs(pendingWaitMs)]);
    if (!settled) {
      // The field is cleared along with the late shutdown: `createTransport`
      // assigns `agent.irohTransport` when it finally lands, so without this
      // the agent is left holding a transport that has already been shut down.
      // Measured by `closes a node that turns up AFTER the teardown gave up
      // waiting`.
      //
      // Falling through rather than returning here is uniformity, NOT a guard,
      // and no test can make it one: reaching this line means the pending
      // creation is still inside `ensureGitignoreHasIrohEntry`, which is the
      // only await `createTransport` has - the ephemeral branch has none, so
      // its promise is always settled by now. On that branch neither
      // `irohTransport` nor `irohStoreDir` has been assigned yet, so both
      // cleanups below are no-ops.
      void observed
        .then((transport) => {
          agent.irohTransport = undefined;
          return transport?.shutdown();
        })
        .catch(() => undefined);
    }
  }
  if (agent.irohTransport) {
    await agent.irohTransport.shutdown().catch(() => {});
    agent.irohTransport = undefined;
  }
  if (agent.irohStoreDir !== undefined) {
    await rm(agent.irohStoreDir, { recursive: true, force: true }).catch(() => {});
    agent.irohStoreDir = undefined;
  }
}
