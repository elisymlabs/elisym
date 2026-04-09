/**
 * Wallet command - show balance and send SOL.
 */
import { formatSol } from '@elisym/sdk';
import { Connection, PublicKey } from '@solana/web3.js';
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
  const connection = new Connection(rpcUrl);
  const pubkey = new PublicKey(solPayment.address);
  const balance = await connection.getBalance(pubkey);

  console.log(`\n  Agent: ${name}`);
  console.log(`  Network: ${network}`);
  console.log(`  Address: ${solPayment.address}`);
  console.log(`  Balance: ${formatSol(balance)} (${balance} lamports)\n`);
}

export async function cmdSend(_name: string, _address: string, _amount: string): Promise<void> {
  console.error('Direct sending not yet implemented. Use the MCP server for payments.');
}
