/**
 * Agent config management - load/save from ~/.elisym/agents/<name>/config.json
 * Uses shared config types and serialization from @elisym/sdk.
 */
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateAgentName, serializeConfig, type AgentConfig } from '@elisym/sdk';
import { parseConfig } from '@elisym/sdk/node';
import { writeFileAtomic } from './atomic-write.js';
import type { AgentSecurityFlags, SolanaNetwork } from './context.js';

/** Detect whether a raw config JSON contains any encrypted secret fields. */
function rawConfigIsEncrypted(raw: string): boolean {
  return raw.includes('"encrypted:v1:');
}

export type { AgentConfig } from '@elisym/sdk';

/** Directory on disk where agent configs live. Computed per-call so tests can override HOME. */
function agentsDir(): string {
  return join(homedir(), '.elisym', 'agents');
}

/** Path to an agent's config file. */
export function agentConfigPath(name: string): string {
  return join(agentsDir(), name, 'config.json');
}

export interface AgentConfigData {
  nostrSecretKey: string;
  solanaSecretKey?: string;
  relays?: string[];
  /** Solana network for RPC + explorer + discovery filter. */
  network: SolanaNetwork;
  payments?: { chain: string; network: string; address: string }[];
  /** per-agent opt-in security flags. */
  security: AgentSecurityFlags;
  /** Whether the on-disk config has any encrypted secret fields. */
  encrypted: boolean;
}

/**
 * Narrow a user-supplied string to a SolanaNetwork. Only `devnet` is supported
 * at the moment; mainnet configs written by older versions throw a migration
 * error so the user can reissue the agent explicitly instead of silently being
 * downgraded.
 */
function coerceNetwork(raw: string | undefined, agentName: string): SolanaNetwork {
  if (raw === undefined || raw === 'devnet') {
    return 'devnet';
  }
  if (raw === 'mainnet') {
    throw new Error(
      `Agent "${agentName}" is configured for mainnet, which is not supported until the ` +
        `elisym-config program is deployed there. Re-create the agent with --network devnet: ` +
        `rm -rf ~/.elisym/agents/${agentName} && elisym-mcp init ${agentName} --network devnet`,
    );
  }
  throw new Error(`Agent "${agentName}" has unsupported network "${raw}". Expected "devnet".`);
}

/**
 * Load agent config from disk. If the config contains encrypted secret fields, pass a
 * passphrase (or set `ELISYM_PASSPHRASE`). Throws with a clear message if the config
 * format is outdated: old pre-0.1.0 configs must be deleted and recreated.
 */
export async function loadAgentConfig(name: string, passphrase?: string): Promise<AgentConfigData> {
  validateAgentName(name);
  const configPath = agentConfigPath(name);
  const raw = await readFile(configPath, 'utf-8');

  // a clear error when a config has encrypted fields but no passphrase is provided.
  const rawEncrypted = rawConfigIsEncrypted(raw);
  // Security note: env vars may be visible via /proc/*/environ on Linux.
  // For production mainnet deployments, consider a credential helper or keyring.
  const effectivePassphrase = passphrase ?? process.env.ELISYM_PASSPHRASE;
  if (rawEncrypted && !effectivePassphrase) {
    throw new Error(
      `Agent "${name}" has an encrypted config but no passphrase. ` +
        `Set the ELISYM_PASSPHRASE environment variable.`,
    );
  }

  let config: AgentConfig & { security?: AgentSecurityFlags };
  try {
    config = parseConfig(raw, effectivePassphrase) as AgentConfig & {
      security?: AgentSecurityFlags;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to load agent "${name}": ${msg}. ` +
        `If this config was created by an earlier version, delete ~/.elisym/agents/${name} and run "elisym-mcp init ${name}" again.`,
    );
  }

  const network = coerceNetwork(config.wallet?.network ?? config.payments?.[0]?.network, name);

  return {
    nostrSecretKey: config.identity.secret_key,
    solanaSecretKey: config.wallet?.secret_key,
    relays: config.relays?.length ? config.relays : undefined,
    network,
    payments: config.payments,
    security: config.security ?? {},
    encrypted: rawEncrypted,
  };
}

export interface SaveAgentConfigInput {
  name: string;
  description: string;
  /**
   * Optional advertised capabilities. Customer-mode agents (the default for the
   * MCP server in 0.1.x) leave this empty - capabilities are only meaningful for
   * provider-mode agents that publish a NIP-89 capability card. Existing callers
   * (e.g. the `create_agent` tool) still pass this through unchanged.
   */
  capabilities?: { name: string; description: string; tags: string[]; price: number }[];
  relays: string[];
  nostrSecretKey: string;
  solanaAddress?: string;
  solanaSecretKey?: string;
  network?: SolanaNetwork;
  /** initial security flags. Both default to `false` (opt-in). */
  security?: AgentSecurityFlags;
  /** optional passphrase; if provided, secret fields are encrypted at rest. */
  passphrase?: string;
}

/** Save agent config to disk. */
export async function saveAgentConfig(name: string, config: SaveAgentConfigInput): Promise<void> {
  validateAgentName(name);
  const agentDirPath = join(agentsDir(), name);
  await mkdir(agentDirPath, { recursive: true, mode: 0o700 });

  const network = config.network ?? 'devnet';
  const { encryptSecret } = await import('@elisym/sdk/node');

  const encrypt = (v: string) => (config.passphrase ? encryptSecret(v, config.passphrase) : v);
  const nostrSecret = encrypt(config.nostrSecretKey);
  const solanaSecret = config.solanaSecretKey ? encrypt(config.solanaSecretKey) : undefined;

  const agentConfig: AgentConfig & { security?: AgentSecurityFlags } = {
    identity: {
      secret_key: nostrSecret,
      name: config.name,
      description: config.description,
    },
    relays: config.relays,
    capabilities: config.capabilities ?? [],
    ...(config.solanaAddress && {
      payments: [
        {
          chain: 'solana',
          network,
          address: config.solanaAddress,
        },
      ],
    }),
    ...(solanaSecret && {
      wallet: {
        chain: 'solana',
        network,
        secret_key: solanaSecret,
      },
    }),
    ...(config.security && { security: config.security }),
  };

  // atomic write - temp file + rename, matches the CHANGELOG security claim.
  await writeFileAtomic(join(agentDirPath, 'config.json'), serializeConfig(agentConfig), 0o600);
}

/** Update (merge) the `security` block of an existing agent config. */
export async function updateAgentSecurity(
  name: string,
  patch: AgentSecurityFlags,
  passphrase?: string,
): Promise<AgentSecurityFlags> {
  validateAgentName(name);
  const configPath = agentConfigPath(name);
  const raw = await readFile(configPath, 'utf-8');
  const effectivePassphrase = passphrase ?? process.env.ELISYM_PASSPHRASE;
  const config = parseConfig(raw, effectivePassphrase) as AgentConfig & {
    security?: AgentSecurityFlags;
  };
  // Preserve the on-disk encryption state by re-encrypting with the same passphrase.
  const rawEncrypted = rawConfigIsEncrypted(raw);
  if (rawEncrypted && !effectivePassphrase) {
    throw new Error(
      `Agent "${name}" is encrypted - set ELISYM_PASSPHRASE to update security flags.`,
    );
  }

  const merged: AgentSecurityFlags = { ...config.security, ...patch };
  const { encryptSecret } = await import('@elisym/sdk/node');
  const encrypt = (v: string) => (effectivePassphrase ? encryptSecret(v, effectivePassphrase) : v);

  const next: AgentConfig & { security?: AgentSecurityFlags } = {
    ...config,
    // parseConfig returns decrypted secrets; re-encrypt them if the file was encrypted
    identity: {
      ...config.identity,
      secret_key: rawEncrypted ? encrypt(config.identity.secret_key) : config.identity.secret_key,
    },
    wallet: config.wallet
      ? {
          ...config.wallet,
          secret_key: rawEncrypted ? encrypt(config.wallet.secret_key) : config.wallet.secret_key,
        }
      : undefined,
    security: merged,
  };
  // atomic write for the security flag update too.
  await writeFileAtomic(configPath, serializeConfig(next), 0o600);
  return merged;
}

/** List all agent names on disk. */
export async function listAgentNames(): Promise<string[]> {
  try {
    const entries = await readdir(agentsDir());
    const names: string[] = [];
    for (const entry of entries) {
      try {
        await stat(join(agentsDir(), entry, 'config.json'));
        names.push(entry);
      } catch {
        // Not an agent directory
      }
    }
    return names;
  } catch {
    return [];
  }
}
