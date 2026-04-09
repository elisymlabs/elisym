/**
 * Agent config management - load/save/list/delete from ~/.elisym/agents/<name>/
 * Uses shared config types and serialization from @elisym/sdk.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateAgentName, serializeConfig, type AgentConfig } from '@elisym/sdk';
import { parseConfig } from '@elisym/sdk/node';

export type { AgentConfig } from '@elisym/sdk';
export type { Identity, Capability, PaymentAddress, WalletConfig, LlmConfig } from '@elisym/sdk';
export { validateAgentName };

const AGENTS_ROOT = join(homedir(), '.elisym', 'agents');

function agentDir(name: string): string {
  return join(AGENTS_ROOT, name);
}

function configPath(name: string): string {
  return join(AGENTS_ROOT, name, 'config.json');
}

export function loadConfig(name: string, passphrase?: string): AgentConfig {
  validateAgentName(name);
  const path = configPath(name);
  const raw = readFileSync(path, 'utf-8');
  return parseConfig(raw, passphrase);
}

export function saveConfig(config: AgentConfig): void {
  validateAgentName(config.identity.name);
  const dir = agentDir(config.identity.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), serializeConfig(config), { mode: 0o600 });
}

export function listAgents(): string[] {
  try {
    return readdirSync(AGENTS_ROOT).filter((name) => {
      try {
        statSync(join(AGENTS_ROOT, name, 'config.json'));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function deleteAgent(name: string): void {
  validateAgentName(name);
  // Overwrite sensitive files with zeros before deletion to prevent forensic recovery
  const dir = agentDir(name);
  for (const file of ['config.json', 'jobs.json']) {
    try {
      const filePath = join(dir, file);
      const size = statSync(filePath).size;
      writeFileSync(filePath, Buffer.alloc(size, 0));
    } catch {
      /* file may not exist */
    }
  }
  // Zero-fill corrupt ledger backups (contain customer IDs, job inputs)
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('jobs.json.corrupt.')) {
        try {
          const fp = join(dir, entry);
          writeFileSync(fp, Buffer.alloc(statSync(fp).size, 0));
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* dir may not exist */
  }
  rmSync(dir, { recursive: true, force: true });
}
