import { ElisymIdentity } from '@elisym/sdk';
import { listAgents, loadAgent } from '@elisym/sdk/agent-store';
/**
 * elisym CLI - agent runner for the elisym network.
 *
 * Commands:
 *   elisym init [name] [--config <path>] [--local]             Create a new agent
 *   elisym start [name]                                         Start agent in provider mode
 *   elisym list                                                 List all agents
 *   elisym profile [name]                                       Edit agent profile
 *   elisym wallet [name]                                        Show wallet balance
 */
process.removeAllListeners('warning');
import { Command } from 'commander';
import { nip19 } from 'nostr-tools';
import { cmdInit, type InitOptions } from './commands/init.js';
import { cmdProfile } from './commands/profile.js';
import { cmdStart } from './commands/start.js';
import { cmdWallet } from './commands/wallet.js';
import { PACKAGE_VERSION } from './version.js';

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
  .name('elisym')
  .description('CLI agent runner for the elisym network')
  .version(PACKAGE_VERSION);

// Init
program
  .command('init [name]')
  .description('Create a new agent')
  .option('-c, --config <path>', 'Load fields from an elisym.yaml template (non-interactive)')
  .option('--local', 'Create in project <project>/.elisym/<name>/ (default: ~/.elisym/<name>/)')
  .option(
    '--passphrase <value>',
    'Passphrase to encrypt secrets at rest. Empty string ("") skips encryption. Also reads ELISYM_PASSPHRASE env var. When neither is provided, prompts interactively.',
  )
  .option(
    '--yes',
    'Skip confirmation prompts (shadow/sibling-location). Fails closed on an existing agent at the same location - never overwrites secrets silently.',
  )
  .action(
    safe(async (name: string | undefined, options: InitOptions) => {
      await cmdInit(name, options);
    }),
  );

// Profile
program
  .command('profile [name]')
  .description('Edit agent profile, wallet, and LLM settings')
  .action(safe(cmdProfile));

// Start
program
  .command('start [name]')
  .description('Start agent in provider mode')
  .option(
    '-v, --verbose',
    'Enable debug logging (relay lifecycle, publish acks, subscription EOSE). Also togglable via ELISYM_DEBUG=1 or LOG_LEVEL=debug.',
  )
  .action(
    safe(async (name: string | undefined, options: { verbose?: boolean }) => {
      await cmdStart(name, options);
    }),
  );

// List
program
  .command('list')
  .description('List all agents (project-local and home-global)')
  .action(
    safe(async () => {
      const cwd = process.cwd();
      const agents = await listAgents(cwd);
      if (agents.length === 0) {
        console.log('No agents found. Run `npx @elisym/cli init` to create one.');
        return;
      }
      console.log('\nAgents:');
      for (const agent of agents) {
        try {
          const loaded = await loadAgent(agent.name, cwd);
          const identity = ElisymIdentity.fromHex(loaded.secrets.nostr_secret_key);
          const npub = nip19.npubEncode(identity.publicKey);
          const solAddr = loaded.yaml.payments[0]?.address
            ? ` | Solana: ${loaded.yaml.payments[0].address}`
            : '';
          const shadow = agent.shadowsGlobal ? ' [shadows global]' : '';
          console.log(`  ${agent.name} (${agent.source})${shadow} | ${npub}${solAddr}`);
        } catch (e: any) {
          const hint = /encrypted secrets/i.test(e?.message ?? '') ? ' (encrypted)' : '';
          console.log(`  ${agent.name} (${agent.source})${hint}`);
        }
      }
      console.log();
    }),
  );

// Wallet
program.command('wallet [name]').description('Show wallet balance').action(safe(cmdWallet));

program.parse();
