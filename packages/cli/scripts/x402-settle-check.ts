/**
 * Throwaway harness: drive the x402 bridge's payment leg directly against a
 * running x402 upstream, WITHOUT the full customer/job flow. It loads an
 * agent, builds the real `X402Driver`, and runs the matching x402 skill's
 * preflight + execute - so it makes ONE real on-chain USDC payment (via the
 * upstream's facilitator) and returns the upstream's response.
 *
 * Prereq: the bridge agent's wallet must hold enough devnet USDC for one
 * upstream quote (the facilitator is fee payer, so no SOL is needed).
 *
 *   cd packages/cli
 *   bun run scripts/x402-settle-check.ts <agent-name> <upstream-url>
 *   # e.g. bun run scripts/x402-settle-check.ts x402test http://localhost:4021/x402/generate
 */
import {
  getProtocolConfig,
  getProtocolProgramId,
  formatAssetAmount,
  USDC_SOLANA_DEVNET,
} from '@elisym/sdk';
import { agentPaths, loadAgent } from '@elisym/sdk/agent-store';
import { address, createSolanaRpc } from '@solana/kit';
import { fetchUsdcBalance, getRpcUrl } from '../src/helpers.js';
import type { SkillContext, SkillInput } from '../src/skill/index.js';
import { loadSkillsFromDir } from '../src/skill/loader.js';
import { X402Driver } from '../src/x402/driver.js';

async function main(): Promise<void> {
  const [agentName, upstreamUrl] = process.argv.slice(2);
  if (agentName === undefined || upstreamUrl === undefined) {
    console.error('usage: bun run scripts/x402-settle-check.ts <agent-name> <upstream-url>');
    process.exit(1);
  }

  const loaded = await loadAgent(agentName, process.cwd(), process.env.ELISYM_PASSPHRASE);
  const skills = loadSkillsFromDir(agentPaths(loaded.dir).skills);
  const skill =
    skills.find((entry) => entry.mode === 'x402' && entry.x402?.url === upstreamUrl) ??
    skills.find((entry) => entry.mode === 'x402');
  if (skill === undefined || skill.x402 === undefined) {
    console.error(`No x402 skill found for ${upstreamUrl} on agent "${agentName}".`);
    process.exit(1);
  }

  const solPayment = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
  const rpcUrl = getRpcUrl('devnet');
  const rpc = createSolanaRpc(rpcUrl);

  if (solPayment?.address !== undefined) {
    const balance = await fetchUsdcBalance(rpc, address(solPayment.address));
    console.log(`  Bridge wallet: ${solPayment.address}`);
    console.log(`  USDC balance:  ${formatAssetAmount(USDC_SOLANA_DEVNET, balance)}`);
    console.log(`  Upstream:      ${upstreamUrl}`);
    console.log(
      `  Ceiling:       ${formatAssetAmount(USDC_SOLANA_DEVNET, skill.x402.maxUpstreamSubunits)}\n`,
    );
  }

  async function fetchLiveFeeBps(): Promise<number> {
    const config = await getProtocolConfig(rpc, getProtocolProgramId('devnet'), {
      forceRefresh: true,
    });
    return config.feeBps;
  }

  const driver = new X402Driver({
    agentDir: loaded.dir,
    paymentsAddress: solPayment?.address,
    solanaSecretKeyBase58: loaded.secrets.solana_secret_key,
    rpcUrl,
    getFeeBps: fetchLiveFeeBps,
    log: (message) => console.log(`  ${message}`),
  });

  const ctx: SkillContext = {
    x402Driver: driver,
    agentName,
    agentDescription: loaded.yaml.description ?? '',
  };

  const input: SkillInput = {
    data: 'a purple square, high detail',
    inputType: 'text',
    tags: [skill.capabilities[0] ?? skill.name],
    // Fresh jobId each run so the idempotency cache never short-circuits the payment.
    jobId: `settle-check-${Date.now()}`,
  };

  console.log('  Preflight (wallet invariant, live quote, balance, margin)...');
  await skill.preflight?.(input, ctx);
  console.log('  Preflight OK. Paying upstream (real devnet settle)...\n');

  const output = await skill.execute(input, ctx);
  console.log('\n  DONE - upstream paid and responded:');
  console.log(`    text bytes: ${output.data.length}`);
  console.log(`    outputMime: ${output.outputMime ?? '(text)'}`);
  console.log(`    filePath:   ${output.filePath ?? '(inline)'}`);
  if (output.filePath !== undefined) {
    const { statSync } = await import('node:fs');
    console.log(
      `    file size:  ${statSync(output.filePath).size} bytes (cached in .x402-results/)`,
    );
  }
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
