/**
 * Pre-create the per-mint `AssetStats` PDAs for a network's known assets.
 *
 * `increment_stats_v2` would self-register a missing PDA on first payment, but
 * that makes the first payer of each asset fund ~0.0019 SOL of rent -
 * pre-creating via the permissionless `create_asset_stats` keeps ordinary
 * payers off that path. Idempotent: re-running against existing PDAs is a
 * no-op.
 *
 * Creates PDAs for: native SOL (sentinel), the network's canonical USDC, and
 * (mainnet only) LSM.
 *
 * Usage:
 *   SOLANA_NETWORK=mainnet SOLANA_RPC_URL=... \
 *     bun run packages/config-client/scripts/create-asset-stats.ts
 *
 * Env:
 *   SOLANA_NETWORK      - 'mainnet' | 'devnet'. Default 'devnet'. Explicit by
 *                         design: the network selects the asset set and must
 *                         NEVER be inferred from the RPC URL (substring
 *                         matching misclassifies custom endpoints - the wrong
 *                         failure mode for a release-gating script).
 *   SOLANA_RPC_URL      - RPC endpoint; falls back to RPC_URL, then devnet.
 *   PROGRAM_ID          - defaults to the Codama-embedded program address.
 *   PAYER_KEYPAIR_PATH  - payer keypair JSON; defaults to
 *                         ~/.config/solana/id.json. Any funded key works -
 *                         the instruction is permissionless.
 *   EXTRA_MINTS         - comma-separated additional mint addresses.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  ELISYM_CONFIG_PROGRAM_ADDRESS,
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveEventAuthorityAddress,
  fetchMaybeAssetStats,
  getCreateAssetStatsInstruction,
} from '../src';

const NETWORK_ENV = process.env.SOLANA_NETWORK ?? 'devnet';
if (NETWORK_ENV !== 'devnet' && NETWORK_ENV !== 'mainnet') {
  console.error(`SOLANA_NETWORK must be 'devnet' or 'mainnet'; got "${NETWORK_ENV}".`);
  process.exit(1);
}
const NETWORK: 'devnet' | 'mainnet' = NETWORK_ENV;

const PROGRAM_ID: Address = process.env.PROGRAM_ID
  ? address(process.env.PROGRAM_ID)
  : ELISYM_CONFIG_PROGRAM_ADDRESS;

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = RPC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? join(homedir(), '.config/solana/id.json');

// Mint literals rather than an @elisym/sdk import: config-client is
// dependency-light and the canonical set is small and stable.
const USDC_DEVNET_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_MAINNET_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const LSM_MAINNET_MINT = address('86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump');

async function main(): Promise<void> {
  const payerSecretKey = new Uint8Array(JSON.parse(readFileSync(PAYER_KEYPAIR_PATH, 'utf8')));
  const payer = await createKeyPairSignerFromBytes(payerSecretKey);
  const eventAuthority = await deriveEventAuthorityAddress(PROGRAM_ID);
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  const extraMints = (process.env.EXTRA_MINTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => address(entry));

  const targets: Array<{ label: string; mint: Address }> = [
    { label: 'native SOL (sentinel)', mint: NATIVE_ASSET_SENTINEL },
    {
      label: `USDC ${NETWORK}`,
      mint: NETWORK === 'mainnet' ? USDC_MAINNET_MINT : USDC_DEVNET_MINT,
    },
    ...(NETWORK === 'mainnet' ? [{ label: 'LSM mainnet', mint: LSM_MAINNET_MINT }] : []),
    ...extraMints.map((mint) => ({ label: `extra ${mint}`, mint })),
  ];

  console.log('Network:   ', NETWORK);
  console.log('RPC:       ', RPC_URL);
  console.log('Program ID:', PROGRAM_ID);
  console.log('Payer:     ', payer.address);

  for (const target of targets) {
    const assetStatsPda = await deriveAssetStatsAddress(PROGRAM_ID, target.mint);
    const existing = await fetchMaybeAssetStats(rpc, assetStatsPda);
    if (existing.exists) {
      console.log(`- ${target.label}: already exists (${assetStatsPda})`);
      continue;
    }

    const ix = getCreateAssetStatsInstruction(
      {
        assetStats: assetStatsPda,
        payer,
        eventAuthority,
        program: PROGRAM_ID,
        mint: target.mint,
      },
      { programAddress: PROGRAM_ID },
    );

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(payer, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstruction(ix, msg),
    );
    const signedTx = await signTransactionMessageWithSigners(message);
    await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
      commitment: 'confirmed',
    });
    const signature = getSignatureFromTransaction(
      signedTx as Parameters<typeof getSignatureFromTransaction>[0],
    );
    console.log(`- ${target.label}: created ${assetStatsPda} (${signature})`);
  }
}

/** Anchor's dispatcher error for an unknown instruction discriminator. */
const ANCHOR_INSTRUCTION_FALLBACK_NOT_FOUND = 101;

/**
 * Did the program reject the instruction because it does not have it?
 *
 * The marker never reaches the error TEXT: kit reports a preflight failure as
 * "Transaction simulation failed" and an unwrapped custom error as
 * "Custom program error: #101" (decimal, and redacted entirely in production
 * builds). `InstructionFallbackNotFound` appears only in the program logs, so
 * match on those and on the nested cause's numeric code.
 */
function isMissingInstructionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (
      isSolanaError(
        current,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    ) {
      const logs = current.context.logs;
      if (
        Array.isArray(logs) &&
        logs.some((line) => line.includes('InstructionFallbackNotFound'))
      ) {
        return true;
      }
    }
    if (
      isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) &&
      Number(current.context.code) === ANCHOR_INSTRUCTION_FALLBACK_NOT_FOUND
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    // The one failure that changes the release decision: a deployed program
    // that predates `create_asset_stats` also lacks `increment_stats_v2`,
    // which every payment transaction bundles - so shipping the SDK against
    // it breaks payments wholesale rather than just costing the first payer
    // rent. Name it instead of leaving a raw Anchor error to interpret.
    if (isMissingInstructionError(error)) {
      console.error(
        '\n  The deployed program does not have create_asset_stats, so it also lacks ' +
          'increment_stats_v2.\n  Upgrade the program before releasing the SDK - see ' +
          'programs/elisym-config/DEPLOY.mainnet.md (deploy vs upgrade).',
      );
    }
    process.exit(1);
  });
