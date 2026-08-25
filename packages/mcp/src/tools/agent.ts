import {
  ElisymClient,
  ElisymIdentity,
  RELAYS,
  exportKeyPairBytes,
  validateAgentName,
} from '@elisym/sdk';
import { resolveAgent } from '@elisym/sdk/agent-store';
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
} from '@solana/kit';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { z } from 'zod';
import { listAgentNames, loadAgentConfig, saveAgentConfig } from '../config.js';
import type { AgentContext, AgentInstance, AgentSecurityFlags, SolanaNetwork } from '../context.js';
import { shutdownIrohTransport } from '../iroh.js';
import { logger } from '../logger.js';
import type { ToolDefinition } from './types.js';
import { defineTool, errorResult, textResult } from './types.js';

const BASE58_ENCODER = getBase58Encoder();
const BASE58_DECODER = getBase58Decoder();

// Canonical implementation moved to the SDK (payment/wallet.ts) so the CLI can
// share it; re-exported here because src/index.ts imports it from this module.
export { exportKeyPairBytes };

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().default('Elisym MCP agent'),
  // capabilities are intentionally not exposed: the MCP server runs in
  // customer-mode in 0.1.x and never publishes a NIP-89 capability card,
  // so an advertised capability list would be misleading. Provider-mode
  // (0.2.0) will reintroduce this field.
  network: z
    .enum(['devnet', 'mainnet'])
    .default('devnet')
    .describe(
      'Solana network this agent is bound to. FIXED AT CREATION: an agent can never change ' +
        'networks - switching networks means creating (or switch_agent-ing to) another agent ' +
        'bound to the other network. Default devnet; mainnet payments move real funds.',
    ),
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
    // The identity copied the bytes - zero this intermediate so scrub()
    // later leaves no second live copy of the secret in memory.
    decoded.data.fill(0);
  } else {
    identity = ElisymIdentity.fromHex(config.nostrSecretKey);
  }
  const client = new ElisymClient({ relays: config.relays ?? RELAYS });

  let solanaKeypair: AgentInstance['solanaKeypair'];
  if (config.solanaSecretKey) {
    try {
      const decoded = new Uint8Array(BASE58_ENCODER.encode(config.solanaSecretKey));
      const signer = await createKeyPairSignerFromBytes(decoded);
      solanaKeypair = {
        publicKey: signer.address,
        secretKey: decoded,
      };
    } catch {
      logger.warn(
        { event: 'invalid_solana_key', agent: name },
        'invalid Solana key - payments disabled',
      );
    }
  }

  const resolved = resolveAgent(name, process.cwd());
  return {
    client,
    identity,
    name,
    network: config.network,
    solanaKeypair,
    security: config.security ?? {},
    agentDir: resolved?.dir,
  };
}

/**
 * Tear down an agent: shut down its iroh blob transport (releases the store
 * fs-lock and network listener, removes an ephemeral tmpdir store), close its
 * relay client, zero its Solana secret key bytes, scrub the Nostr identity,
 * and drop it from the registry. The agent will be reloaded from disk if
 * switched back to later. Shared by `switch_agent` and `stop_agent`; mirrors
 * the per-agent teardown in `server.ts::shutdown`.
 */
async function scrubAgent(ctx: AgentContext, agent: AgentInstance): Promise<void> {
  await shutdownIrohTransport(agent);
  try {
    agent.client.close();
  } catch (error) {
    // A failing relay teardown must not abort the scrub - the secret-zeroing
    // below still has to run. Log only the error class: a raw message could
    // carry key material (same concern as server.ts's redactSecrets).
    logger.warn(
      {
        event: 'close_failed',
        agent: agent.name,
        err: error instanceof Error ? error.name : 'unknown',
      },
      'agent client close failed during scrub',
    );
  }
  if (agent.solanaKeypair) {
    agent.solanaKeypair.secretKey.fill(0);
  }
  agent.identity.scrub();
  ctx.registry.delete(agent.name);
}

export const agentTools: ToolDefinition[] = [
  defineTool({
    name: 'create_agent',
    description:
      'Create a new agent identity. Generates Nostr keypair and Solana wallet, ' +
      'saves config to ~/.elisym/<name>/. The Solana network is fixed at creation: ' +
      'there is no way to switch an existing agent between devnet and mainnet - ' +
      'create an agent per network and use switch_agent to move between them. ' +
      'When activate=true (default), the ' +
      'current active agent must have `security.agent_switch_enabled` set to true, ' +
      'otherwise the new agent is created but NOT activated (pass activate=false or ' +
      'run `npx @elisym/mcp enable-agent-switch <current-agent>`).',
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
          logger.warn(
            { event: 'agent_switch_gate_bypassed', context: 'create_agent' },
            'ELISYM_ALLOW_AGENT_SWITCH override active - agent switch gate bypassed',
          );
        }
        try {
          const current = ctx.active();
          if (!envOverride && !current.security.agent_switch_enabled) {
            return errorResult(
              `Cannot activate a new agent: agent_switch is disabled for current agent ` +
                `"${current.name}". Either create with activate=false, or enable the flag ` +
                `on the current agent first: npx @elisym/mcp enable-agent-switch ${current.name}`,
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
      const solanaSecretBase58 = BASE58_DECODER.decode(solanaSecretBytes);

      try {
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
      } catch (e) {
        return errorResult(
          `Failed to create agent "${input.name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Build and register agent
      const instance = await buildAgentInstance(input.name, {
        nostrSecretKey: nostrSecretHex,
        solanaSecretKey: solanaSecretBase58,
        network: input.network,
        security: { withdrawals_enabled: false, agent_switch_enabled: false },
      });
      // Activation pivots away from the current agent - mirror switch_agent's
      // teardown so the old agent's keys and iroh transport don't linger.
      if (input.activate) {
        let old: AgentInstance | undefined;
        try {
          old = ctx.active();
        } catch {
          // No active agent - nothing to scrub.
        }
        if (old && old.name !== input.name) {
          await scrubAgent(ctx, old);
        }
      }
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
      ctx.toolRateLimiter.check();
      // gate switch_agent behind an explicit opt-in flag. The active agent's flag
      // governs whether pivoting away from it is allowed - this prevents a prompt-
      // injected instruction from silently hopping to a different wallet.
      const envOverride = process.env.ELISYM_ALLOW_AGENT_SWITCH === '1';
      if (envOverride) {
        logger.warn(
          { event: 'agent_switch_gate_bypassed', context: 'switch_agent' },
          'ELISYM_ALLOW_AGENT_SWITCH override active - agent switch gate bypassed',
        );
      }
      try {
        const currentAgent = ctx.active();
        if (!envOverride && !currentAgent.security.agent_switch_enabled) {
          return errorResult(
            `switch_agent is disabled for agent "${currentAgent.name}". ` +
              `Enable with: npx @elisym/mcp enable-agent-switch ${currentAgent.name}`,
          );
        }
      } catch {
        // No active agent yet - allow the switch
      }

      // Resolve the OLD agent up front (if any) but do NOT tear it down yet. The
      // target must be loaded and validated FIRST so a bad target name leaves the
      // current session fully intact. Only after the target is ready do we scrub
      // and close the old agent so its secret key bytes don't linger in memory.
      let old: AgentInstance | undefined;
      try {
        old = ctx.active();
      } catch {
        // No active agent - nothing to scrub later.
      }

      // Fast path: target already loaded in the registry. No disk load needed,
      // so there is nothing to fail - flip the active pointer and scrub the old.
      if (ctx.registry.has(input.name)) {
        if (old && old.name !== input.name) {
          await scrubAgent(ctx, old);
        }
        ctx.activeAgentName = input.name;
        const agent = ctx.active();
        const npub = agent.identity.npub;
        return textResult(`Switched to agent "${input.name}" (${npub}).`);
      }

      // Load + build the target from disk FIRST. On any failure here the current
      // agent is untouched and we surface the error.
      let instance: AgentInstance;
      try {
        const config = await loadAgentConfig(input.name);
        instance = await buildAgentInstance(input.name, config);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`Failed to load agent "${input.name}": ${msg}`);
      }

      // Target is ready - now it is safe to tear down the old agent.
      if (old && old.name !== input.name) {
        await scrubAgent(ctx, old);
      }
      ctx.register(instance, true);

      const npub = instance.identity.npub;
      return textResult(`Loaded and switched to agent "${input.name}" (${npub}).`);
    },
  }),

  defineTool({
    name: 'list_agents',
    description: 'List all loaded agents and show which one is currently active.',
    schema: ListAgentsSchema,
    async handler(ctx) {
      ctx.toolRateLimiter.check();
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
      ctx.toolRateLimiter.check();
      if (input.name === ctx.activeAgentName) {
        return errorResult('Cannot stop the active agent. Switch to another agent first.');
      }

      const agent = ctx.registry.get(input.name);
      if (!agent) {
        return errorResult(`Agent "${input.name}" is not loaded.`);
      }

      // Shut down iroh, close the client, zero secret key bytes, scrub
      // identity, drop from registry.
      await scrubAgent(ctx, agent);

      return textResult(`Agent "${input.name}" stopped and removed.`);
    },
  }),
];
