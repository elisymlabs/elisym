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
import { join } from 'node:path';
import { createIrohTransport, type IrohBlobTransport } from '@elisym/sdk/node';
import type { AgentInstance } from './context';

/** Get (creating on first use) the agent's iroh transport. */
export function ensureIrohTransport(agent: AgentInstance): IrohBlobTransport {
  if (agent.irohTransport) {
    return agent.irohTransport;
  }
  let storePath: string;
  if (agent.agentDir !== undefined) {
    storePath = join(agent.agentDir, '.iroh');
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
  if (agent.irohTransport) {
    await agent.irohTransport.shutdown().catch(() => {});
    agent.irohTransport = undefined;
  }
  if (agent.irohStoreDir !== undefined) {
    await rm(agent.irohStoreDir, { recursive: true, force: true }).catch(() => {});
    agent.irohStoreDir = undefined;
  }
}
