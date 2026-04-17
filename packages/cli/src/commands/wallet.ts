/**
 * Wallet command - show balance.
 */
import { formatSol } from '@elisym/sdk';
import { loadAgent, listAgents } from '@elisym/sdk/agent-store';
import { address, createSolanaRpc } from '@solana/kit';
import { getRpcUrl } from '../helpers.js';

export async function cmdWallet(name: string | undefined): Promise<void> {
  const cwd = process.cwd();

  if (!name) {
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
    name = selected;
  }

  const passphrase = process.env.ELISYM_PASSPHRASE;
  const loaded = await loadAgent(name!, cwd, passphrase);

  const solPayment = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
  if (!solPayment?.address) {
    console.error('Solana address not configured for this agent.');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(solPayment.network);
  const rpc = createSolanaRpc(rpcUrl);
  const walletAddress = address(solPayment.address);
  const { value: balance } = await rpc.getBalance(walletAddress).send();

  console.log(`\n  Agent: ${name}`);
  console.log(`  Network: ${solPayment.network}`);
  console.log(`  Address: ${solPayment.address}`);
  console.log(`  Balance: ${formatSol(Number(balance))} (${balance} lamports)\n`);
}
