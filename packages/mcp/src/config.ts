import { join } from 'node:path';
/**
 * MCP adapter over @elisym/sdk/agent-store.
 * Keeps the same load/save/list API surface used by MCP tools, server, and CLI
 * subcommands - internally backed by the new .elisym/<name>/ YAML layout.
 */
import { validateAgentName } from '@elisym/sdk';
import {
  createAgentDir,
  homeElisymDir,
  listAgents as listStoreAgents,
  loadAgent,
  writeExampleSkillTemplate,
  writeSecrets,
  writeYaml,
  writeYamlInitial,
} from '@elisym/sdk/agent-store';
import type { AgentSecurityFlags, SolanaNetwork } from './context.js';

/** Absolute path where the agent's YAML lives. Used in error hints. */
export function agentConfigPath(name: string): string {
  return join(homeElisymDir(), name, 'elisym.yaml');
}

/** Coerce a payments[].network to the narrow SolanaNetwork type. */
function coerceNetwork(raw: string | undefined, name: string): SolanaNetwork {
  if (raw === undefined || raw === 'devnet') {
    return 'devnet';
  }
  if (raw === 'mainnet') {
    throw new Error(
      `Agent "${name}" is configured for mainnet, which is not supported until the ` +
        `elisym-config program is deployed there. Re-create the agent with --network devnet: ` +
        `rm -rf ~/.elisym/${name} && npx @elisym/mcp init ${name} --network devnet`,
    );
  }
  throw new Error(`Agent "${name}" has unsupported network "${raw}". Expected "devnet".`);
}

export interface AgentConfigData {
  nostrSecretKey: string;
  solanaSecretKey?: string;
  relays?: string[];
  network: SolanaNetwork;
  payments?: { chain: string; network: string; address: string }[];
  security: AgentSecurityFlags;
  encrypted: boolean;
}

/**
 * Load agent config from disk. Reads elisym.yaml + .secrets.json from
 * ~/.elisym/<name>/ (home layout). If secrets are encrypted, a passphrase
 * is required (either the `passphrase` argument or the ELISYM_PASSPHRASE
 * environment variable).
 */
export async function loadAgentConfig(name: string, passphrase?: string): Promise<AgentConfigData> {
  validateAgentName(name);
  const loaded = await loadAgent(name, process.cwd(), passphrase);
  const solPayment = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
  const network = coerceNetwork(solPayment?.network, name);

  return {
    nostrSecretKey: loaded.secrets.nostr_secret_key,
    solanaSecretKey: loaded.secrets.solana_secret_key,
    relays: loaded.yaml.relays.length > 0 ? loaded.yaml.relays : undefined,
    network,
    payments:
      loaded.yaml.payments.length > 0
        ? loaded.yaml.payments.map((payment) => ({
            chain: payment.chain,
            network: payment.network,
            address: payment.address,
          }))
        : undefined,
    security: {
      withdrawals_enabled: loaded.yaml.security.withdrawals_enabled,
      agent_switch_enabled: loaded.yaml.security.agent_switch_enabled,
    },
    encrypted: loaded.encrypted,
  };
}

export interface SaveAgentConfigInput {
  name: string;
  description: string;
  relays: string[];
  nostrSecretKey: string;
  solanaAddress?: string;
  solanaSecretKey?: string;
  network?: SolanaNetwork;
  security?: AgentSecurityFlags;
  /** Optional passphrase; if provided, secret fields are encrypted at rest. */
  passphrase?: string;
}

/** Save an agent to ~/.elisym/<name>/ (home layout). Overwrites if present. */
export async function saveAgentConfig(name: string, input: SaveAgentConfigInput): Promise<void> {
  validateAgentName(name);
  const created = await createAgentDir({ target: 'home', name, cwd: process.cwd() });
  const network = input.network ?? 'devnet';

  await writeYamlInitial(created.dir, {
    display_name: undefined,
    description: input.description,
    picture: undefined,
    banner: undefined,
    relays: input.relays,
    payments: input.solanaAddress
      ? [{ chain: 'solana', network, address: input.solanaAddress }]
      : [],
    llm: undefined,
    security: input.security ?? {},
  });

  await writeExampleSkillTemplate(created.dir);

  await writeSecrets(
    created.dir,
    {
      nostr_secret_key: input.nostrSecretKey,
      solana_secret_key: input.solanaSecretKey,
    },
    input.passphrase,
  );
}

/** Merge `patch` into the agent's security flags. Returns the merged flags. */
export async function updateAgentSecurity(
  name: string,
  patch: AgentSecurityFlags,
  passphrase?: string,
): Promise<AgentSecurityFlags> {
  const loaded = await loadAgent(name, process.cwd(), passphrase);
  const merged: AgentSecurityFlags = { ...loaded.yaml.security, ...patch };
  await writeYaml(loaded.dir, { ...loaded.yaml, security: merged });
  return merged;
}

/** List all agent names discoverable from the current working directory. */
export async function listAgentNames(): Promise<string[]> {
  const agents = await listStoreAgents(process.cwd());
  return agents.map((agent) => agent.name);
}
