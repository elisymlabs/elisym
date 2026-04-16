import { ElisymClient, ElisymIdentity, RELAYS, validateAgentName } from '@elisym/sdk';
import {
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
} from '@solana/kit';
import bs58 from 'bs58';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { z } from 'zod';
import { listAgentNames, loadAgentConfig, saveAgentConfig } from '../config.js';
import type { AgentInstance, AgentSecurityFlags, SolanaNetwork } from '../context.js';
import type { ToolDefinition } from './types.js';
import { defineTool, errorResult, textResult } from './types.js';

/**
 * Extract the 64-byte secret key (32-byte private seed + 32-byte public key)
 * from an extractable KeyPairSigner. This matches the format used by solana-keygen
 * and createKeyPairSignerFromBytes.
 */
export async function exportKeyPairBytes(signer: KeyPairSigner): Promise<Uint8Array> {
  const { privateKey, publicKey } = signer.keyPair;
  const [pkcs8, rawPub] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', privateKey),
    crypto.subtle.exportKey('raw', publicKey),
  ]);
  // PKCS#8 has a fixed 16-byte Ed25519 header; the raw 32-byte seed follows.
  const privateBytes = new Uint8Array(pkcs8).slice(16);
  const publicBytes = new Uint8Array(rawPub);
  const bytes = new Uint8Array(64);
  bytes.set(privateBytes, 0);
  bytes.set(publicBytes, 32);
  return bytes;
}

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().default('Elisym MCP agent'),
  // capabilities are intentionally not exposed: the MCP server runs in
  // customer-mode in 0.1.x and never publishes a NIP-89 capability card,
  // so an advertised capability list would be misleading. Provider-mode
  // (0.2.0) will reintroduce this field.
  network: z.enum(['devnet', 'mainnet']).default('devnet'),
  passphrase: z
    .string()
    .optional()
    .describe('Optional passphrase; if set, secret keys are encrypted at rest.'),
  activate: z.boolean().default(true),
});

const SwitchAgentSchema = z.object({
  name: z.string(),
});

const ListAgentsSchema = z.object({});

const StopAgentSchema = z.object({
  name: z.string(),
});

/**
 * Build an AgentInstance from a name and a decrypted config.
 */
export async function buildAgentInstance(
  name: string,
  config: {
    nostrSecretKey: string;
    solanaSecretKey?: string;
    relays?: string[];
    network: SolanaNetwork;
    security?: AgentSecurityFlags;
  },
): Promise<AgentInstance> {
  // validate the nip19 decode type instead of casting blindly.
  let identity: ElisymIdentity;
  if (config.nostrSecretKey.startsWith('nsec')) {
    const decoded = nip19.decode(config.nostrSecretKey);
    if (decoded.type !== 'nsec') {
      throw new Error(`Expected nsec, got ${decoded.type}`);
    }
    identity = ElisymIdentity.fromSecretKey(decoded.data);
  } else {
    identity = ElisymIdentity.fromHex(config.nostrSecretKey);
  }
  const client = new ElisymClient({ relays: config.relays ?? RELAYS });

  let solanaKeypair: AgentInstance['solanaKeypair'];
  if (config.solanaSecretKey) {
    try {
      const decoded = bs58.decode(config.solanaSecretKey);
      const signer = await createKeyPairSignerFromBytes(decoded);
      solanaKeypair = {
        publicKey: signer.address,
        secretKey: decoded,
      };
    } catch {
      console.error(`[mcp:warn] Invalid Solana key for agent "${name}" - payments disabled`);
    }
  }

  return {
    client,
    identity,
    name,
    network: config.network,
    solanaKeypair,
    security: config.security ?? {},
  };
}

export const agentTools: ToolDefinition[] = [
  defineTool({
    name: 'create_agent',
    description:
      'Create a new agent identity. Generates Nostr keypair and Solana wallet, ' +
      'saves config to ~/.elisym/agents/<name>/. When activate=true (default), the ' +
      'current active agent must have `security.agent_switch_enabled` set to true, ' +
      'otherwise the new agent is created but NOT activated (pass activate=false or ' +
      'run `elisym-mcp enable-agent-switch <current-agent>`).',
    schema: CreateAgentSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      // reuse the SDK's authoritative validator instead of a local regex.
      try {
        validateAgentName(input.name);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }

      // Refuse to overwrite an existing agent - generating new keys would destroy the old ones.
      const existingNames = await listAgentNames();
      if (existingNames.includes(input.name)) {
        return errorResult(
          `Agent "${input.name}" already exists. Use switch_agent to load it, ` +
            `or choose a different name.`,
        );
      }

      // create_agent used to silently pivot the active agent when
      // activate=true, bypassing the switch_agent gate. A prompt injection of the form
      // "create a new agent and use it" would sidestep `security.agent_switch_enabled`
      // completely. Now we enforce the same gate that switch_agent enforces.
      if (input.activate) {
        const envOverride = process.env.ELISYM_ALLOW_AGENT_SWITCH === '1';
        if (envOverride) {
          console.error(
            '[mcp:security] ELISYM_ALLOW_AGENT_SWITCH override active - agent switch gate bypassed',
          );
        }
        try {
          const current = ctx.active();
          if (!envOverride && !current.security.agent_switch_enabled) {
            return errorResult(
              `Cannot activate a new agent: agent_switch is disabled for current agent ` +
                `"${current.name}". Either create with activate=false, or enable the flag ` +
                `on the current agent first: elisym-mcp enable-agent-switch ${current.name}`,
            );
          }
        } catch {
          // No active agent yet - first-run create, allow.
        }
      }

      // Generate keys
      const nostrSecretKey = generateSecretKey();
      const solanaSigner = await generateKeyPairSigner(true);
      const solanaSecretBytes = await exportKeyPairBytes(solanaSigner);

      const nostrSecretHex = Buffer.from(nostrSecretKey).toString('hex');
      const solanaSecretBase58 = bs58.encode(solanaSecretBytes);

      await saveAgentConfig(input.name, {
        name: input.name,
        description: input.description,
        relays: [...RELAYS],
        nostrSecretKey: nostrSecretHex,
        solanaSecretKey: solanaSecretBase58,
        solanaAddress: solanaSigner.address,
        network: input.network,
        security: { withdrawals_enabled: false, agent_switch_enabled: false },
        passphrase: input.passphrase,
      });

      // Build and register agent
      const instance = await buildAgentInstance(input.name, {
        nostrSecretKey: nostrSecretHex,
        solanaSecretKey: solanaSecretBase58,
        network: input.network,
        security: { withdrawals_enabled: false, agent_switch_enabled: false },
      });
      ctx.register(instance, input.activate);

      return textResult(
        `Agent "${input.name}" created.\n` +
          `Nostr: ${instance.identity.npub}\n` +
          `Solana: ${solanaSigner.address}\n` +
          (input.activate ? 'Activated as current agent.' : ''),
      );
    },
  }),

  defineTool({
    name: 'switch_agent',
    description:
      'Switch the active agent. Loads from disk if not already loaded. ' +
      'Gated by `security.agent_switch_enabled` in the target agent config ' +
      '(or the ELISYM_ALLOW_AGENT_SWITCH=1 env var for CI). ' +
      'All subsequent tool calls will use this agent.',
    schema: SwitchAgentSchema,
    async handler(ctx, input) {
      // gate switch_agent behind an explicit opt-in flag. The active agent's flag
      // governs whether pivoting away from it is allowed - this prevents a prompt-
      // injected instruction from silently hopping to a different wallet.
      const envOverride = process.env.ELISYM_ALLOW_AGENT_SWITCH === '1';
      if (envOverride) {
        console.error(
          '[mcp:security] ELISYM_ALLOW_AGENT_SWITCH override active - agent switch gate bypassed',
        );
      }
      try {
        const currentAgent = ctx.active();
        if (!envOverride && !currentAgent.security.agent_switch_enabled) {
          return errorResult(
            `switch_agent is disabled for agent "${currentAgent.name}". ` +
              `Enable with: elisym-mcp enable-agent-switch ${currentAgent.name}`,
          );
        }
      } catch {
        // No active agent yet - allow the switch
      }

      // scrub and close the old agent before switching so secret key bytes
      // don't linger in memory. The old agent is removed from the registry and
      // will be reloaded from disk if switched back to later.
      try {
        const old = ctx.active();
        if (old.name !== input.name) {
          old.client.close();
          if (old.solanaKeypair) {
            old.solanaKeypair.secretKey.fill(0);
          }
          old.identity.scrub();
          ctx.registry.delete(old.name);
        }
      } catch {
        // No active agent - nothing to scrub
      }

      // Check if already loaded
      if (ctx.registry.has(input.name)) {
        ctx.activeAgentName = input.name;
        const agent = ctx.active();
        const npub = agent.identity.npub;
        return textResult(`Switched to agent "${input.name}" (${npub}).`);
      }

      // Load from disk
      try {
        const config = await loadAgentConfig(input.name);
        const instance = await buildAgentInstance(input.name, config);
        ctx.register(instance, true);

        const npub = instance.identity.npub;
        return textResult(`Loaded and switched to agent "${input.name}" (${npub}).`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`Failed to load agent "${input.name}": ${msg}`);
      }
    },
  }),

  defineTool({
    name: 'list_agents',
    description: 'List all loaded agents and show which one is currently active.',
    schema: ListAgentsSchema,
    async handler(ctx) {
      // return structured JSON so downstream LLMs can program against stable field
      // names instead of parsing a bespoke plaintext format.
      const loaded = [];
      for (const [name, agent] of ctx.registry) {
        loaded.push({
          name,
          active: name === ctx.activeAgentName,
          loaded: true,
          npub: agent.identity.npub,
          network: agent.network,
          solana_address: agent.solanaKeypair?.publicKey,
        });
      }

      const onDisk: Array<{ name: string; active: false; loaded: false }> = [];
      try {
        const diskNames = await listAgentNames();
        for (const name of diskNames) {
          if (!ctx.registry.has(name)) {
            onDisk.push({ name, active: false, loaded: false });
          }
        }
      } catch {
        // Ignore disk read errors
      }

      if (loaded.length === 0 && onDisk.length === 0) {
        return textResult(
          JSON.stringify(
            { agents: [], message: 'No agents found. Use create_agent to create one.' },
            null,
            2,
          ),
        );
      }

      return textResult(
        JSON.stringify(
          {
            active: ctx.activeAgentName ?? null,
            agents: [...loaded, ...onDisk],
          },
          null,
          2,
        ),
      );
    },
  }),

  defineTool({
    name: 'stop_agent',
    description: 'Stop a loaded agent. Disconnects from relays. Cannot stop the active agent.',
    schema: StopAgentSchema,
    async handler(ctx, input) {
      if (input.name === ctx.activeAgentName) {
        return errorResult('Cannot stop the active agent. Switch to another agent first.');
      }

      const agent = ctx.registry.get(input.name);
      if (!agent) {
        return errorResult(`Agent "${input.name}" is not loaded.`);
      }

      agent.client.close();
      // best-effort scrub of secret key bytes before dropping the agent.
      if (agent.solanaKeypair) {
        agent.solanaKeypair.secretKey.fill(0);
      }
      agent.identity.scrub();
      ctx.registry.delete(input.name);

      return textResult(`Agent "${input.name}" stopped and removed.`);
    },
  }),
];
