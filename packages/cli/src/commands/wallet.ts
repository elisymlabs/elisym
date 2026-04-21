/**
 * Wallet command - show SOL and USDC balance.
 */
import { USDC_SOLANA_DEVNET, formatAssetAmount, formatSol } from '@elisym/sdk';
import { loadAgent, listAgents } from '@elisym/sdk/agent-store';
import { type Rpc, type SolanaRpcApi, address, createSolanaRpc } from '@solana/kit';
import { getRpcUrl } from '../helpers.js';

async function fetchUsdcBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: ReturnType<typeof address>,
): Promise<bigint> {
  const mint = USDC_SOLANA_DEVNET.mint;
  if (!mint) {
    return 0n;
  }
  try {
    const response = await rpc
      .getTokenAccountsByOwner(
        owner,
        { mint: address(mint) },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      )
      .send();
    let total = 0n;
    for (const entry of response.value) {
      const parsed = entry.account.data as
        | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
        | undefined;
      const raw = parsed?.parsed?.info?.tokenAmount?.amount;
      if (typeof raw === 'string') {
        total += BigInt(raw);
      }
    }
    return total;
  } catch {
    return 0n;
  }
}

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
  const usdcBalance = await fetchUsdcBalance(rpc, walletAddress);

  console.log(`\n  Agent: ${name}`);
  console.log(`  Network: ${solPayment.network}`);
  console.log(`  Address: ${solPayment.address}`);
  console.log(`  SOL balance: ${formatSol(Number(balance))} (${balance} lamports)`);
  console.log(`  USDC balance: ${formatAssetAmount(USDC_SOLANA_DEVNET, usdcBalance)}\n`);
}
