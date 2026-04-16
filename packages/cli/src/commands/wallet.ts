/**
 * Wallet command - show balance.
 */
import { formatSol } from '@elisym/sdk';
import { address, createSolanaRpc } from '@solana/kit';
import { loadConfig, listAgents } from '../config.js';
import { getRpcUrl } from '../helpers.js';

export async function cmdWallet(name: string | undefined): Promise<void> {
  if (!name) {
    const agents = listAgents();
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
        choices: agents,
      },
    ]);
    name = selected;
  }

  const passphrase = process.env.ELISYM_PASSPHRASE;
  const config = loadConfig(name!, passphrase);

  const solPayment = config.payments?.find((p) => p.chain === 'solana');
  if (!solPayment?.address) {
    console.error('Solana address not configured for this agent.');
    process.exit(1);
  }

  const network = solPayment.network ?? 'devnet';
  const rpcUrl = getRpcUrl(network);
  const rpc = createSolanaRpc(rpcUrl);
  const walletAddress = address(solPayment.address);
  const { value: balance } = await rpc.getBalance(walletAddress).send();

  console.log(`\n  Agent: ${name}`);
  console.log(`  Network: ${network}`);
  console.log(`  Address: ${solPayment.address}`);
  console.log(`  Balance: ${formatSol(Number(balance))} (${balance} lamports)\n`);
}
