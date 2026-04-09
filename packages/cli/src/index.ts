/**
 * elisym CLI - agent runner for the elisym network.
 *
 * Commands:
 *   elisym init              Create a new agent (interactive wizard)
 *   elisym start [name]      Start agent in provider mode
 *   elisym list              List all agents
 *   elisym status <name>     Show agent status
 *   elisym wallet [name]     Show wallet balance
 *   elisym send <name> <address> <amount>  Send SOL
 *   elisym delete <name>     Delete an agent
 *   elisym config <name>     Show agent config (redacted)
 */
process.removeAllListeners('warning');
import { Command } from 'commander';
import { nip19, getPublicKey } from 'nostr-tools';
import { cmdInit } from './commands/init.js';
import { cmdProfile } from './commands/profile.js';
import { cmdStart } from './commands/start.js';
import { cmdWallet, cmdSend } from './commands/wallet.js';
import { loadConfig, listAgents, deleteAgent } from './config.js';

const program = new Command()
  .name('elisym')
  .description('CLI agent runner for the elisym network')
  .version('0.1.0');

// Init
program.command('init').description('Create a new agent (interactive wizard)').action(cmdInit);

// Profile
program
  .command('profile [name]')
  .description('Edit agent profile, wallet, and LLM settings')
  .action(cmdProfile);

// Start
program
  .command('start [name]')
  .description('Start agent in provider mode')
  .option('--headless', 'Run without TUI (log to stdout)')
  .action(cmdStart);

// List
program
  .command('list')
  .description('List all agents')
  .action(() => {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log('No agents found. Run `elisym init` to create one.');
      return;
    }
    console.log('\nAgents:');
    for (const name of agents) {
      try {
        const config = loadConfig(name);
        const secretKey = config.identity.secret_key;
        let npub = '(encrypted)';
        if (!secretKey.startsWith('encrypted:')) {
          const secretBytes = Buffer.from(secretKey, 'hex');
          npub =
            secretBytes.length === 32
              ? nip19.npubEncode(getPublicKey(secretBytes))
              : '(invalid key)';
        }
        const solAddr = config.payments?.[0]?.address
          ? ` | Solana: ${config.payments[0].address}`
          : '';
        console.log(`  ${name} | ${npub}${solAddr}`);
      } catch {
        console.log(`  ${name} (error loading config)`);
      }
    }
    console.log();
  });

// Status
program
  .command('status <name>')
  .description('Show agent status')
  .action((name: string) => {
    try {
      const config = loadConfig(name);
      console.log(`\nAgent: ${name}`);
      console.log(`  Description: ${config.identity.description || '(none)'}`);
      console.log(
        `  Capabilities: ${(config.capabilities ?? []).map((c) => c.name).join(', ') || '(none)'}`,
      );
      console.log(`  Relays: ${config.relays.join(', ')}`);
      if (config.payments?.length) {
        console.log(`  Network: ${config.payments[0].network}`);
        console.log(`  Address: ${config.payments[0].address}`);
      }
      if (config.llm) {
        console.log(`  LLM: ${config.llm.provider} / ${config.llm.model}`);
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

// Wallet
program.command('wallet [name]').description('Show wallet balance').action(cmdWallet);

// Send
program
  .command('send <name> <address> <amount>')
  .description('Send SOL from agent wallet')
  .action(cmdSend);

// Delete
program
  .command('delete <name>')
  .description('Delete an agent')
  .action(async (name: string) => {
    const { default: inquirer } = await import('inquirer');
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Delete agent "${name}"? This cannot be undone.`,
        default: false,
      },
    ]);
    if (confirm) {
      deleteAgent(name);
      console.log(`Agent "${name}" deleted.`);
    }
  });

// Config
program
  .command('config <name>')
  .description('Show agent config (secrets redacted)')
  .action((name: string) => {
    try {
      const config = loadConfig(name);
      const redacted = {
        ...config,
        identity: { ...config.identity, secret_key: '***REDACTED***' },
        wallet: config.wallet ? { ...config.wallet, secret_key: '***REDACTED***' } : undefined,
        llm: config.llm ? { ...config.llm, api_key: '***REDACTED***' } : undefined,
      };
      console.log(JSON.stringify(redacted, null, 2));
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

program.parse();
