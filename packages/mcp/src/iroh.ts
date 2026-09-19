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
export function ensureIrohTransport(agent: AgentInstance): Promise<IrohBlobTransport> {
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
    return Promise.resolve(agent.irohTransport);
  }
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

/** Shut down the agent's iroh node (release the fs-lock) and clean an ephemeral store. */
export async function shutdownIrohTransport(agent: AgentInstance): Promise<void> {
  // The PENDING one too: a shutdown that races a first file transfer would
  // otherwise leave a node holding the store lock with nothing referencing it.
  const pending = agent.irohTransportPending;
  if (pending) {
    await pending.catch(() => undefined);
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
