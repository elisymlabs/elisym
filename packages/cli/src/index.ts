/**
 * elisym CLI - agent runner for the elisym network.
 *
 * Commands:
 *   elisym init              Create a new agent (interactive wizard)
 *   elisym start [name]      Start agent in provider mode
 *   elisym list              List all agents
 *   elisym profile [name]    Edit agent profile, wallet, and LLM settings
 *   elisym wallet [name]     Show wallet balance
 *   elisym delete <name>     Delete an agent
 */
process.removeAllListeners('warning');
import { Command } from 'commander';
import { nip19, getPublicKey } from 'nostr-tools';
import { cmdInit } from './commands/init.js';
import { cmdProfile } from './commands/profile.js';
import { cmdStart } from './commands/start.js';
import { cmdWallet } from './commands/wallet.js';
import { loadConfig, listAgents, deleteAgent } from './config.js';
import { PACKAGE_VERSION } from './version.js';

const program = new Command()
  .name('elisym')
  .description('CLI agent runner for the elisym network')
  .version(PACKAGE_VERSION);

// Init
program.command('init').description('Create a new agent (interactive wizard)').action(cmdInit);

// Profile
program
  .command('profile [name]')
  .description('Edit agent profile, wallet, and LLM settings')
  .action(cmdProfile);

// Start
program.command('start [name]').description('Start agent in provider mode').action(cmdStart);

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

// Wallet
program.command('wallet [name]').description('Show wallet balance').action(cmdWallet);

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

program.parse();
