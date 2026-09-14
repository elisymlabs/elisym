#!/usr/bin/env bun
/**
 * Phase 3 reference: a bounded-spend agent (application layer, NOT an SDK rail).
 *
 * Demonstrates the consume side of `spl-approve` delegation: an agent that a
 * customer approved for up to `cap` USDC uses ITS OWN delegate key to spend
 * autonomously - no customer signature per action. elisym provides exactly the
 * `Transfer USDC <= cap` primitive (`buildDelegatedTransfer`); what the agent
 * composes with it (pay a provider, convert, swap up to N) is application-layer
 * and external to elisym. This script shows the primitive and the honest
 * routing note; it is a template, not a shipped product.
 *
 * Invariant regardless of composition: at most `cap` USDC ever leaves the
 * customer's account, and after USDC -> anything the agent has NO authority over
 * the output (the approve was on the USDC account only).
 *
 * Run (with a delegate key an owner has already approved; `NETWORK` defaults
 * to devnet and drives the USDC mint and the RPC defaults):
 *
 *   NETWORK=devnet|mainnet \
 *   DELEGATE_SECRET=<base58 delegate key> \
 *   OWNER_ADDRESS=<the customer wallet that approved this delegate> \
 *   SPEND_USDC=0.25 \
 *   [PAYEE_ADDRESS=<provider wallet>]   # omit => pull-to-self
 *   bun packages/sdk/scripts/reference-bounded-spend.ts
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { buildDelegatedTransfer, deriveOwnerDelegationAta, getDelegation } from '../src/delegation';
import { formatAssetAmount, parseAssetAmount, resolveUsdcAsset } from '../src/payment/assets';
import { signerFromSecretKeyBase58 } from '../src/payment/wallet';
import type { Network } from '../src/types';

const NETWORK: Network = process.env.NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  (NETWORK === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const WS_URL =
  process.env.SOLANA_WS_URL ??
  (NETWORK === 'mainnet' ? 'wss://api.mainnet-beta.solana.com' : 'wss://api.devnet.solana.com');
const USDC_ASSET = resolveUsdcAsset(NETWORK);

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const delegate = await signerFromSecretKeyBase58(requireEnv('DELEGATE_SECRET'));
  const ownerAddress = requireEnv('OWNER_ADDRESS');
  const spendHuman = requireEnv('SPEND_USDC');
  const payeeAddress = process.env.PAYEE_ADDRESS;

  const requested = parseAssetAmount(USDC_ASSET, spendHuman);
  const ownerAta = await deriveOwnerDelegationAta(ownerAddress, NETWORK);

  // 1. Confirm THIS delegate is authorized and read the remaining cap. The agent
  // must never assume the allowance - a revoke or a spend by another path may
  // have shrunk it since discovery.
  const status = await getDelegation(rpc, ownerAta);
  if (status === null) {
    console.error(
      `Owner ATA ${ownerAta} does not exist on-chain - the owner has no USDC token account, ` +
        `so nothing has been delegated. The owner must approve first.`,
    );
    process.exit(1);
  }
  if (status.delegate !== delegate.address) {
    console.error(
      `This delegate (${delegate.address}) is not authorized on ${ownerAta}. ` +
        `Current delegate: ${status.delegate ?? 'none'}. The owner must approve first.`,
    );
    process.exit(1);
  }

  // 2. Never exceed the remaining cap. Spend min(requested, remaining).
  const amount = requested < status.remainingCap ? requested : status.remainingCap;
  if (amount <= 0n) {
    console.error('Remaining allowance is 0 - nothing to spend.');
    process.exit(1);
  }
  console.log(
    `Remaining allowance ${formatAssetAmount(USDC_ASSET, status.remainingCap)}; ` +
      `spending ${formatAssetAmount(USDC_ASSET, amount)}.`,
  );

  // 3. Resolve the destination ATA.
  // - Pull-to-self ALWAYS works: transfer <= cap to the agent's own USDC ATA,
  //   then act on funds it fully controls (swap, convert - application-layer).
  // - A direct pay to a provider's ATA also works: it is still a plain transfer.
  // - A direct delegate-authority *program* call (e.g. an on-chain swap that
  //   pulls from the owner ATA) is route-dependent: the program must accept an
  //   arbitrary (source, authority) pair. When it does not, fall back to
  //   pull-to-self. That composition is NOT built here - this is the rail only.
  const destinationOwner = address(payeeAddress ?? delegate.address);
  const [destinationAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: address(USDC_ASSET.mint ?? ''),
  });

  const transferIx = await buildDelegatedTransfer({
    delegate,
    source: ownerAta,
    destination: destinationAta,
    amount,
    network: NETWORK,
  });

  // The agent pays its own gas and idempotently ensures the destination ATA
  // exists (harmless if it already does).
  const instructions: readonly unknown[] = [
    getCreateAssociatedTokenIdempotentInstruction(
      {
        payer: delegate,
        ata: destinationAta,
        owner: destinationOwner,
        mint: address(USDC_ASSET.mint ?? ''),
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    ),
    ...transferIx,
  ];

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(delegate, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: 'confirmed' });
  const signature = getSignatureFromTransaction(signed);

  const after = await getDelegation(rpc, ownerAta);
  // `getDelegation` is `DelegationStatus | null` (null = ATA gone). A transfer
  // never closes the account, so `after` is non-null in practice, but guard the
  // read rather than dereference a possibly-null value.
  const remainingLine = after
    ? `Remaining allowance now ${formatAssetAmount(USDC_ASSET, after.remainingCap)}.`
    : 'Remaining allowance now unknown (owner ATA not found).';
  console.log(
    `Spent. Signature: ${signature}\n` +
      `Destination: ${destinationAta}${payeeAddress ? ' (payee)' : ' (pull-to-self)'}\n` +
      remainingLine,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
