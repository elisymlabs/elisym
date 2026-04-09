import { ElisymClient, ElisymIdentity, RELAYS } from '@elisym/sdk';
import { Keypair } from '@solana/web3.js';
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
import { runInstall, runUninstall, runList } from './install.js';
import { startServer } from './server.js';
import { buildAgentInstance } from './tools/agent.js';
import { PACKAGE_VERSION } from './utils.js';

const program = new Command()
  .name('elisym-mcp')
  .description('MCP server for the elisym agent network')
  // version from package.json, same source as the MCP server capability block.
  .version(PACKAGE_VERSION);

// Default action: start MCP server
program.action(async () => {
  const ctx = new AgentContext();

  // Resolve agent identity
  const agentName = process.env.ELISYM_AGENT;
  const nostrSecret = process.env.ELISYM_NOSTR_SECRET;

  if (agentName) {
    // Load existing agent from disk
    try {
      const config = await loadAgentConfig(agentName);
      const instance = buildAgentInstance(agentName, config);
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
    const network = process.env.ELISYM_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';

    ctx.register({ client, identity, name, network, security: {} });
    console.error(`Ephemeral agent: ${name} (${network})`);
  } else {
    // default agent selection is deterministic (alphabetical sort) so the
    // "first" agent doesn't depend on filesystem ordering.
    const names = (await listAgentNames()).slice().sort();
    if (names.length > 0) {
      const name = names[0]!;
      try {
        const config = await loadAgentConfig(name);
        const instance = buildAgentInstance(name, config);
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
});

// Init subcommand
program
  .command('init [name]')
  .description('Create a new agent identity')
  .option('-d, --description <desc>', 'Agent description', 'Elisym MCP agent')
  .option('-c, --capabilities <caps>', 'Comma-separated capabilities', 'mcp-gateway')
  .option('-n, --network <network>', 'Solana network (devnet|mainnet)', 'devnet')
  .option('--install', 'Also install into MCP clients')
  .action(async (name: string | undefined, options) => {
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
          type: 'input',
          name: 'capabilities',
          message: 'Capabilities (comma-separated):',
          default: 'mcp-gateway',
        },
        {
          type: 'list',
          name: 'network',
          message: 'Solana network:',
          // testnet removed - only devnet and mainnet are supported.
          choices: ['devnet', 'mainnet'],
          default: 'devnet',
        },
      ]);
      name = answers.name;
      options.description = answers.description;
      options.capabilities = answers.capabilities;
      options.network = answers.network;
    }

    // enforce the two-network contract even when invoked non-interactively.
    if (options.network !== 'devnet' && options.network !== 'mainnet') {
      console.error(`Network must be "devnet" or "mainnet", got "${options.network}".`);
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
    const solanaKeypair = Keypair.generate();

    // build proper Capability records; the previous `string[]` form produced
    // configs that `parseConfig` rejected on next load.
    const capabilities = (options.capabilities as string)
      .split(',')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0)
      .map((tag: string) => ({ name: tag, description: tag, tags: [tag], price: 0 }));

    await saveAgentConfig(name!, {
      name: name!,
      description: options.description,
      capabilities,
      relays: [...RELAYS],
      nostrSecretKey: Buffer.from(nostrSecretKey).toString('hex'),
      solanaSecretKey: bs58.encode(solanaKeypair.secretKey),
      solanaAddress: solanaKeypair.publicKey.toBase58(),
      network: options.network as 'devnet' | 'mainnet',
      security: { withdrawals_enabled: false, agent_switch_enabled: false },
      passphrase: passphrase || undefined,
    });

    const npub = nip19.npubEncode(nostrPubkey);
    console.log(`Agent "${name}" created.`);
    console.log(`  Nostr: ${npub}`);
    console.log(`  Solana: ${solanaKeypair.publicKey.toBase58()}`);
    console.log(`  Network: ${options.network}`);
    console.log(`  Encrypted: ${passphrase ? 'yes' : 'no'}`);
    console.log(`  Config: ~/.elisym/agents/${name}/config.json`);
    if (passphrase) {
      console.log(`  Note: set ELISYM_PASSPHRASE before launching the MCP server.`);
    }

    if (options.install) {
      await runInstall({ agent: name });
    }
  });

// Install subcommand
program
  .command('install')
  .description('Install elisym MCP server into client configs')
  .option('--client <name>', 'Specific client (claude-desktop, cursor, windsurf)')
  .option('--agent <name>', 'Bind to specific agent')
  .option('--list', 'List detected clients')
  .action(async (options) => {
    if (options.list) {
      await runList();
    } else {
      await runInstall({ client: options.client, agent: options.agent });
    }
  });

// Uninstall subcommand
program
  .command('uninstall')
  .description('Remove elisym from MCP client configs')
  .option('--client <name>', 'Specific client')
  .action(async (options) => {
    await runUninstall({ client: options.client });
  });

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
  .action((agent: string) => toggleFlag(agent, 'withdrawals_enabled', true));

program
  .command('disable-withdrawals <agent>')
  .description('Disable SOL withdrawals for a specific agent')
  .action((agent: string) => toggleFlag(agent, 'withdrawals_enabled', false));

program
  .command('enable-agent-switch <agent>')
  .description('Allow the MCP server to switch away from this agent at runtime')
  .action((agent: string) => toggleFlag(agent, 'agent_switch_enabled', true));

program
  .command('disable-agent-switch <agent>')
  .description('Forbid the MCP server from switching away from this agent at runtime')
  .action((agent: string) => toggleFlag(agent, 'agent_switch_enabled', false));

program.parse();
