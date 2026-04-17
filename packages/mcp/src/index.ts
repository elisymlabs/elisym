// Suppress Node's DEP0040 (`punycode` deprecation) emitted by a transitive dep.
// It fires to stderr exactly when inquirer is rendering the `init` prompt and
// corrupts the TTY output. We filter only that one warning and re-emit the rest.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'DeprecationWarning' && /punycode/.test(w.message)) {
    return;
  }
  console.warn(w);
});

import { ElisymClient, ElisymIdentity, RELAYS } from '@elisym/sdk';
import { generateKeyPairSigner } from '@solana/kit';
import bs58 from 'bs58';
/**
 * elisym MCP server - entry point.
 *
 * CLI modes:
 *   elisym-mcp                     Start stdio MCP server
 *   elisym-mcp init [name]         Create agent identity
 *   elisym-mcp install             Install into MCP clients
 *   elisym-mcp uninstall           Remove from MCP clients
 */
import { Command } from 'commander';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { loadAgentConfig, saveAgentConfig, listAgentNames, updateAgentSecurity } from './config.js';
import { AgentContext } from './context.js';
import { runInstall, runUninstall, runUpdate, runList } from './install.js';
import { startServer } from './server.js';
import { buildAgentInstance, exportKeyPairBytes } from './tools/agent.js';
import { PACKAGE_VERSION } from './utils.js';

/**
 * Wrap an action handler so any thrown Error surfaces as a single clean line
 * with exit 1 instead of an unhandled-rejection stack trace.
 */
function safe<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  };
}

const program = new Command()
  .name('elisym-mcp')
  .description('MCP server for the elisym agent network')
  // version from package.json, same source as the MCP server capability block.
  .version(PACKAGE_VERSION);

// Default action: start MCP server
program.action(
  safe(async () => {
    const ctx = new AgentContext();

    // Resolve agent identity
    const agentName = process.env.ELISYM_AGENT;
    const nostrSecret = process.env.ELISYM_NOSTR_SECRET;

    if (agentName) {
      // Load existing agent from disk
      try {
        const config = await loadAgentConfig(agentName);
        const instance = await buildAgentInstance(agentName, config);
        ctx.register(instance);
        console.error(`Loaded agent: ${agentName}`);
      } catch (e: any) {
        console.error(`Failed to load agent "${agentName}": ${e.message}`);
        process.exit(1);
      }
    } else if (nostrSecret) {
      // Ephemeral mode with provided key.
      let identity;
      if (nostrSecret.startsWith('nsec')) {
        const decoded = nip19.decode(nostrSecret);
        if (decoded.type !== 'nsec') {
          console.error(`ELISYM_NOSTR_SECRET: expected nsec, got ${decoded.type}`);
          process.exit(1);
        }
        identity = ElisymIdentity.fromSecretKey(decoded.data);
      } else {
        identity = ElisymIdentity.fromHex(nostrSecret);
      }
      const client = new ElisymClient({ relays: RELAYS });
      const name = process.env.ELISYM_AGENT_NAME ?? 'mcp-agent';
      if (process.env.ELISYM_NETWORK && process.env.ELISYM_NETWORK !== 'devnet') {
        console.error(
          `ELISYM_NETWORK="${process.env.ELISYM_NETWORK}" is not supported. ` +
            `Only "devnet" is available until the on-chain protocol program ships on mainnet.`,
        );
        process.exit(1);
      }

      ctx.register({ client, identity, name, network: 'devnet', security: {} });
      console.error(`Ephemeral agent: ${name} (devnet)`);
    } else {
      // default agent selection is deterministic (alphabetical sort) so the
      // "first" agent doesn't depend on filesystem ordering.
      const names = (await listAgentNames()).slice().sort();
      if (names.length > 0) {
        const name = names[0]!;
        try {
          const config = await loadAgentConfig(name);
          const instance = await buildAgentInstance(name, config);
          ctx.register(instance);
          console.error(`Loaded default agent: ${name} (${instance.network})`);
        } catch (e: any) {
          console.error(`Failed to load agent "${name}": ${e.message}`);
          process.exit(1);
        }
      } else {
        // Auto-create ephemeral agent
        const identity = ElisymIdentity.generate();
        const client = new ElisymClient({ relays: RELAYS });
        ctx.register({ client, identity, name: 'mcp-agent', network: 'devnet', security: {} });
        console.error('Created ephemeral agent (no persistent identity, devnet).');
      }
    }

    await startServer(ctx);
  }),
);

// Init subcommand
program
  .command('init [name]')
  .description('Create a new agent identity')
  .option('-d, --description <desc>', 'Agent description', 'Elisym MCP agent')
  // capabilities are intentionally not exposed here: the MCP server runs in
  // customer-mode in 0.1.x, so an advertised capability list would be misleading.
  // provider-mode (0.2.0) will reintroduce this prompt.
  .option('-n, --network <network>', 'Solana network (devnet only)', 'devnet')
  .option('--install', 'Also install into MCP clients')
  .action(
    safe(async (name: string | undefined, options) => {
      const { default: inquirer } = await import('inquirer');
      if (!name) {
        // Interactive mode
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: 'Agent name:',
            validate: (v: string) => /^[a-zA-Z0-9_-]+$/.test(v) || 'Alphanumeric, _, - only',
          },
          {
            type: 'input',
            name: 'description',
            message: 'Description:',
            default: 'Elisym MCP agent',
          },
          {
            type: 'list',
            name: 'network',
            message: 'Solana network:',
            // Only devnet is supported until the elisym-config program ships on mainnet.
            choices: ['devnet'],
            default: 'devnet',
          },
        ]);
        name = answers.name;
        options.description = answers.description;
        options.network = answers.network;
      }

      if (options.network !== 'devnet') {
        console.error(
          `Network must be "devnet", got "${options.network}". ` +
            `Mainnet is not supported until the on-chain protocol program is deployed.`,
        );
        process.exit(1);
      }

      // optionally encrypt secret keys with a passphrase. Empty passphrase = no encryption.
      const { passphrase } = await inquirer.prompt([
        {
          type: 'password',
          name: 'passphrase',
          message: 'Passphrase to encrypt secret keys (leave blank for none):',
          mask: '*',
        },
      ]);

      const nostrSecretKey = generateSecretKey();
      const nostrPubkey = getPublicKey(nostrSecretKey);
      const solanaSigner = await generateKeyPairSigner(true);
      const solanaSecretBytes = await exportKeyPairBytes(solanaSigner);

      await saveAgentConfig(name!, {
        name: name!,
        description: options.description,
        relays: [...RELAYS],
        nostrSecretKey: Buffer.from(nostrSecretKey).toString('hex'),
        solanaSecretKey: bs58.encode(solanaSecretBytes),
        solanaAddress: solanaSigner.address,
        network: 'devnet',
        security: { withdrawals_enabled: false, agent_switch_enabled: false },
        passphrase: passphrase || undefined,
      });

      const npub = nip19.npubEncode(nostrPubkey);
      console.log(`Agent "${name}" created.`);
      console.log(`  Nostr: ${npub}`);
      console.log(`  Solana: ${solanaSigner.address}`);
      console.log(`  Network: ${options.network}`);
      console.log(`  Encrypted: ${passphrase ? 'yes' : 'no'}`);
      console.log(`  Config: ~/.elisym/${name}/elisym.yaml`);
      if (passphrase) {
        console.log(`  Note: set ELISYM_PASSPHRASE before launching the MCP server.`);
      }

      if (options.install) {
        await runInstall({ agent: name });
      }
    }),
  );

// Install subcommand
program
  .command('install')
  .description('Install elisym MCP server into client configs')
  .option('--client <name>', 'Specific client (claude-desktop, claude-code, cursor, windsurf)')
  .option('--agent <name>', 'Bind to specific agent')
  .option('--list', 'List detected clients')
  .action(
    safe(async (options) => {
      if (options.list) {
        await runList();
      } else {
        await runInstall({ client: options.client, agent: options.agent });
      }
    }),
  );

// Update subcommand: refresh the version pin (and optionally agent binding) in
// all client configs that already have elisym installed. Existing agent + env
// are preserved unless explicitly overridden.
program
  .command('update')
  .description('Refresh the elisym MCP entry in installed client configs')
  .option('--client <name>', 'Specific client (claude-desktop, claude-code, cursor, windsurf)')
  .option('--agent <name>', 'Override the agent binding')
  .action(
    safe(async (options) => {
      await runUpdate({ client: options.client, agent: options.agent });
    }),
  );

// Uninstall subcommand
program
  .command('uninstall')
  .description('Remove elisym from MCP client configs')
  .option('--client <name>', 'Specific client')
  .action(
    safe(async (options) => {
      await runUninstall({ client: options.client });
    }),
  );

/**
 * toggle `security.withdrawals_enabled` for an agent with human confirmation.
 */
async function toggleFlag(
  agentName: string,
  field: 'withdrawals_enabled' | 'agent_switch_enabled',
  enable: boolean,
): Promise<void> {
  const { default: inquirer } = await import('inquirer');
  if (enable) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message:
          field === 'withdrawals_enabled'
            ? `Enable SOL withdrawals for agent "${agentName}"? This allows the MCP tool to move funds out of the agent wallet.`
            : `Enable agent_switch for agent "${agentName}"? This lets the MCP pivot to a different agent at runtime.`,
        default: false,
      },
    ]);
    if (!confirm) {
      console.log('Aborted.');
      return;
    }
  }
  const merged = await updateAgentSecurity(agentName, { [field]: enable });
  console.log(`Agent "${agentName}" security:`, merged);
  console.log('Note: restart the MCP server for changes to take effect on a running session.');
}

program
  .command('enable-withdrawals <agent>')
  .description('Enable SOL withdrawals for a specific agent (interactive confirmation)')
  .action(safe((agent: string) => toggleFlag(agent, 'withdrawals_enabled', true)));

program
  .command('disable-withdrawals <agent>')
  .description('Disable SOL withdrawals for a specific agent')
  .action(safe((agent: string) => toggleFlag(agent, 'withdrawals_enabled', false)));

program
  .command('enable-agent-switch <agent>')
  .description('Allow the MCP server to switch away from this agent at runtime')
  .action(safe((agent: string) => toggleFlag(agent, 'agent_switch_enabled', true)));

program
  .command('disable-agent-switch <agent>')
  .description('Forbid the MCP server from switching away from this agent at runtime')
  .action(safe((agent: string) => toggleFlag(agent, 'agent_switch_enabled', false)));

program.parse();
