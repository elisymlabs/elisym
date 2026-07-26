/**
 * `elisym delegate-key [name]` - manage the agent's dedicated delegate signing
 * key for `spl-approve` delegated execution.
 *
 * The delegate key is SEPARATE from the agent's payment/x402 signer
 * (`solana_secret_key`) for blast-radius isolation: a single compromise must
 * not both drain the agent's own balance and act as delegate for every owner
 * who approved it. Its pubkey is published on the capability card at
 * `elisym start`; without this key an agent cannot advertise `delegation`.
 * The key signs only capped `transferChecked`s (application-layer), so it needs
 * a small SOL gas float on its own address.
 *
 * Rotating the key invalidates every outstanding owner approval (they become
 * unusable-not-stealable - fail-safe; owners must re-approve).
 */
import { formatSol, generateSolanaWallet, signerFromSecretKeyBase58 } from '@elisym/sdk';
import { listAgents, loadAgent, writeSecrets } from '@elisym/sdk/agent-store';
import { address, createSolanaRpc } from '@solana/kit';
import { getRpcUrl } from '../helpers.js';
import { parseImportedSecret } from './x402-add.js';

export interface DelegateKeyOptions {
  /** Print the existing delegate pubkey/address only; never generate. */
  show?: boolean;
  /** Import an existing key (solana-keygen JSON path or base58) instead of generating. */
  import?: boolean;
  /** Replace an existing delegate key (invalidates outstanding owner approvals). */
  rotate?: boolean;
  /** Skip confirmation prompts (requires an explicit agent argument). */
  yes?: boolean;
}

async function resolveAgentName(
  name: string | undefined,
  cwd: string,
  nonInteractive: boolean,
): Promise<string> {
  if (name) {
    return name;
  }
  if (nonInteractive) {
    // --yes disables the interactive picker, so a missing name has nothing to
    // resolve to. Fail fast rather than hang on an inquirer prompt in CI
    // (mirrors `elisym x402 add`).
    console.error('--yes needs an explicit agent argument: elisym delegate-key <agent> --yes');
    process.exit(1);
  }
  const agents = await listAgents(cwd);
  if (agents.length === 0) {
    console.error('No agents found.');
    process.exit(1);
  }
  const { default: inquirer } = await import('inquirer');
  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Select agent:',
      choices: agents.map((agent) => ({
        name: `${agent.name} (${agent.source})`,
        value: agent.name,
      })),
    },
  ]);
  return selected as string;
}

async function printDelegateStatus(delegateSecretKey: string, network: string): Promise<void> {
  const signer = await signerFromSecretKeyBase58(delegateSecretKey);
  const rpc = createSolanaRpc(getRpcUrl(network));
  let gasLine = '';
  try {
    const { value: balance } = await rpc.getBalance(address(signer.address)).send();
    gasLine = `  SOL (gas):     ${formatSol(Number(balance))} (${balance} lamports)`;
  } catch {
    gasLine = '  SOL (gas):     <balance unavailable>';
  }
  console.log(`\n  Delegate key (spl-approve):`);
  console.log(`  Pubkey:        ${signer.address}`);
  console.log(gasLine);
  console.log(
    `\n  Fund this address with a small amount of SOL for transaction gas.\n` +
      `  It is published on this agent's capability cards that declare delegation.\n`,
  );
}

export async function cmdDelegateKey(
  name: string | undefined,
  options: DelegateKeyOptions,
): Promise<void> {
  const cwd = process.cwd();
  const agentName = await resolveAgentName(name, cwd, options.yes === true);
  const passphrase = process.env.ELISYM_PASSPHRASE;
  const loaded = await loadAgent(agentName, cwd, passphrase);

  const network =
    loaded.yaml.payments.find((entry) => entry.chain === 'solana')?.network ?? 'devnet';
  const existing = loaded.secrets.solana_delegate_secret_key;

  if (options.show) {
    if (!existing) {
      console.error(
        `Agent "${agentName}" has no delegate key. Run \`elisym delegate-key ${agentName}\` to create one.`,
      );
      process.exit(1);
    }
    await printDelegateStatus(existing, network);
    return;
  }

  if (existing && !options.rotate) {
    console.log(`  Agent "${agentName}" already has a delegate key.`);
    await printDelegateStatus(existing, network);
    console.log('  Use --rotate to replace it (this invalidates outstanding owner approvals).');
    return;
  }

  // Non-interactive safety: never generate/rotate a money-adjacent key silently.
  const nonInteractive = options.yes === true;
  if (options.rotate && existing && !nonInteractive) {
    const { default: inquirer } = await import('inquirer');
    const { confirmRotate } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmRotate',
        default: false,
        message:
          'Rotating the delegate key invalidates every outstanding owner approval ' +
          '(owners must re-approve the new key). Continue?',
      },
    ]);
    if (!confirmRotate) {
      console.log('  Aborted. Delegate key unchanged.');
      return;
    }
  }

  let delegateSecretKey: string;
  if (options.import) {
    if (nonInteractive) {
      console.error(
        'Import is interactive (it prompts for the key). Re-run without --yes to import.',
      );
      process.exit(1);
    }
    const { default: inquirer } = await import('inquirer');
    const { imported } = await inquirer.prompt([
      {
        type: 'password',
        mask: '*',
        name: 'imported',
        message: 'Path to a solana-keygen JSON file (or paste a base58 secret key):',
      },
    ]);
    try {
      delegateSecretKey = await parseImportedSecret(imported as string);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    const wallet = await generateSolanaWallet();
    delegateSecretKey = wallet.secretKeyBase58;
  }

  // Guard the isolation invariant: the delegate key must differ from the
  // payment/x402 signer, else a single compromise has the full blast radius.
  if (loaded.secrets.solana_secret_key) {
    const paymentSigner = await signerFromSecretKeyBase58(loaded.secrets.solana_secret_key);
    const delegateSigner = await signerFromSecretKeyBase58(delegateSecretKey);
    if (paymentSigner.address === delegateSigner.address) {
      console.error(
        'The delegate key must differ from the agent payment key (solana_secret_key) for blast-radius isolation.',
      );
      process.exit(1);
    }
  }

  await writeSecrets(
    loaded.dir,
    { ...loaded.secrets, solana_delegate_secret_key: delegateSecretKey },
    passphrase,
  );
  console.log(
    existing ? '\n  Delegate key rotated and saved.' : '\n  Delegate key generated and saved.',
  );
  await printDelegateStatus(delegateSecretKey, network);
}
