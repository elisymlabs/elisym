import { ElisymIdentity } from '@elisym/sdk';
import { listAgents, loadAgent } from '@elisym/sdk/agent-store';
/**
 * elisym CLI - agent runner for the elisym network.
 *
 * Commands:
 *   elisym init [name] [--config <path>] [--defaults] [--local]  Create a new agent
 *   elisym start [name]                                         Start agent in provider mode
 *   elisym list                                                 List all agents
 *   elisym profile [name]                                       Edit agent profile
 *   elisym wallet [name]                                        Show wallet balance
 *   elisym identity link <github|x|website> [agent]             Link an external identity
 *   elisym identity status [agent]                              Verify linked identities
 *   elisym identity unlink <github|x|website> [agent]           Unlink an external identity
 */
process.removeAllListeners('warning');
import { Command } from 'commander';
import { nip19 } from 'nostr-tools';
import { cmdDelegateKey, type DelegateKeyOptions } from './commands/delegate-key.js';
import { cmdIdentityLink, cmdIdentityStatus, cmdIdentityUnlink } from './commands/identity.js';
import { cmdInit, type InitOptions } from './commands/init.js';
import { cmdProfile } from './commands/profile.js';
import { cmdStart } from './commands/start.js';
import { cmdWallet } from './commands/wallet.js';
import { cmdX402Add, type X402AddOptions } from './commands/x402-add.js';
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
  .option(
    '--defaults',
    'Skip every prompt and use the same defaults the wizard would have suggested (description, default relays, no payments, no LLM, no encryption). Mutually exclusive with --config.',
  )
  .option('--local', 'Create in project <project>/.elisym/<name>/ (default: ~/.elisym/<name>/)')
  .option(
    '--network <network>',
    'Solana network for the wallet entry: devnet (default) or mainnet (REAL funds, no faucet). The network is fixed at init - to go mainnet later, create a new agent.',
  )
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

// Delegate key (spl-approve delegated execution)
program
  .command('delegate-key [name]')
  .description("Generate, show, or rotate the agent's dedicated delegate signing key (spl-approve)")
  .option('--show', 'Print the existing delegate pubkey/address only')
  .option(
    '--import',
    'Import an existing key (solana-keygen JSON path or base58) instead of generating',
  )
  .option('--rotate', 'Replace an existing delegate key (invalidates outstanding owner approvals)')
  .option('--yes', 'Skip confirmation prompts (requires an explicit agent argument)')
  .action(
    safe(async (name: string | undefined, options: DelegateKeyOptions) => {
      await cmdDelegateKey(name, options);
    }),
  );

// Identity
const identity = program
  .command('identity')
  .description('Link, verify, and unlink external identities (GitHub, X, website)');
identity
  .command('link <platform> [agent]')
  .description(
    'Link a github|x|website identity: prints the NIP-39 proof template, verifies the proof live, writes elisym.yaml, and publishes the claim (kind 10011 / kind-0 nip05)',
  )
  .action(
    safe(async (platform: string, agent: string | undefined) => {
      await cmdIdentityLink(platform, agent);
      // nostr-tools leaves CONNECTING-state relay sockets open after close()
      // (they are only closed when already OPEN), so a one-shot relay command
      // must exit explicitly or the event loop never drains.
      process.exit(0);
    }),
  );
identity
  .command('status [agent]')
  .description(
    'List linked identities with live proof verification and published-claim drift check',
  )
  .action(
    safe(async (agent: string | undefined) => {
      await cmdIdentityStatus(agent);
      process.exit(0); // see the identity-link note on lingering relay sockets
    }),
  );
identity
  .command('unlink <platform> [agent]')
  .description('Remove a github|x|website identity and retract the published claim')
  .action(
    safe(async (platform: string, agent: string | undefined) => {
      await cmdIdentityUnlink(platform, agent);
      process.exit(0); // see the identity-link note on lingering relay sockets
    }),
  );

// x402 bridge
const x402 = program
  .command('x402')
  .description('Bridge x402-paid HTTP services into elisym skills');
x402
  .command('add <url> [agent]')
  .description('Generate a bridge skill from a live x402 endpoint (probes its 402 challenge)')
  .option('--method <method>', 'HTTP method for the upstream call: GET or POST (default POST)')
  .option(
    '--query-param <name>',
    'GET only: query parameter carrying the buyer input (omitting it on GET makes a no-input skill)',
  )
  .option(
    '--margin-bps <bps>',
    'Operator margin over the upstream quote in basis points (default 1000 = 10%)',
  )
  .option('--name <skill-name>', 'Override the generated skill name (also the discovery d-tag)')
  .option(
    '--generate-wallet',
    'Non-interactive runs only: generate a new Solana wallet key when the agent has none',
  )
  .option('--yes', 'Skip confirmation prompts (requires an explicit agent argument)')
  .action(
    safe(async (url: string, agent: string | undefined, options: X402AddOptions) => {
      await cmdX402Add(url, agent, options);
    }),
  );

program.parse();
