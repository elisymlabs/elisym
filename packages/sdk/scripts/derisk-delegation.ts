#!/usr/bin/env bun
/**
 * Phase 0 de-risk: prove the SPL-approve delegation invariants on live devnet.
 *
 * This is a MANUAL tool, not a CI test - it needs a devnet-USDC-funded owner
 * account (devnet USDC mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; fund
 * via https://faucet.circle.com selecting Solana Devnet). SOL for gas is
 * airdropped automatically. Run:
 *
 *   OWNER_SECRET=<base58 64-byte owner key with devnet USDC> \
 *   bun packages/sdk/scripts/derisk-delegation.ts
 *
 * Without OWNER_SECRET it generates a fresh owner, airdrops SOL, and then stops
 * with faucet instructions (a fresh account has no USDC to delegate).
 *
 * It verifies, against the real Token program:
 *  1. owner `approveChecked`s a delegate for `cap`; `getDelegation` reflects it;
 *  2. the delegate `transferChecked`s WITHIN cap (succeeds, cap ratchets down);
 *  3. the delegate `transferChecked`s OVER the remaining cap (rejected);
 *  4. the delegate CANNOT escalate - Approve / SetAuthority(AccountOwner) /
 *     CloseAccount signed by the delegate all fail (owner-only);
 *  5. a fresh owner `approve` REPLACES the remaining cap (re-arm, not additive);
 *  6. owner `revoke` clears the delegate (`getDelegation` shows none).
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AuthorityType,
  getApproveInstruction,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSetAuthorityInstruction,
} from '@solana-program/token';
import {
  type Address,
  type KeyPairSigner,
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  buildApproveDelegate,
  buildDelegatedTransfer,
  buildRevokeDelegate,
  type DelegationStatus,
  deriveOwnerDelegationAta,
  getDelegation,
} from '../src/delegation';
import { USDC_SOLANA_DEVNET } from '../src/payment/assets';
import { generateSolanaWallet, signerFromSecretKeyBase58 } from '../src/payment/wallet';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = process.env.SOLANA_WS_URL ?? 'wss://api.devnet.solana.com';
const NETWORK = 'devnet' as const;
const USDC_MINT = address(USDC_SOLANA_DEVNET.mint ?? '');

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

let passed = 0;
let failed = 0;

function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function bad(label: string, detail?: string): void {
  failed += 1;
  console.error(`  ✗ ${label}${detail ? ` - ${detail}` : ''}`);
}

async function sendInstructions(
  feePayer: KeyPairSigner,
  instructions: readonly unknown[],
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}

/**
 * `getDelegation` returns null for a not-yet-created ATA. In this script the
 * owner ATA always exists at read time (the approve created/funded it), so a
 * null here is a genuine failure - surface it rather than a confusing crash.
 */
async function readDelegation(ownerAta: Address): Promise<DelegationStatus> {
  const status = await getDelegation(rpc, ownerAta);
  if (status === null) {
    throw new Error(`owner ATA ${ownerAta} does not exist on-chain`);
  }
  return status;
}

/** Runs a send expected to FAIL on-chain; passes the check only if it throws. */
async function expectReject(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    bad(label, 'expected on-chain rejection, but it SUCCEEDED');
  } catch {
    ok(label);
  }
}

async function ensureSol(signer: KeyPairSigner, label: string): Promise<void> {
  const { value: balance } = await rpc.getBalance(signer.address).send();
  if (balance >= 200_000_000n) {
    return;
  }
  console.log(`  ...airdropping 2 SOL to ${label} (${signer.address})`);
  try {
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(2_000_000_000n),
      commitment: 'confirmed',
    });
  } catch (error) {
    console.warn(
      `  ! airdrop failed (devnet rate limit?). Fund ${signer.address} manually. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function usdcBalance(ata: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  console.log(`\nSPL-approve delegation de-risk (devnet: ${RPC_URL})\n`);

  const owner = process.env.OWNER_SECRET
    ? await signerFromSecretKeyBase58(process.env.OWNER_SECRET)
    : (await generateSolanaWallet()).signer;
  const delegate = process.env.DELEGATE_SECRET
    ? await signerFromSecretKeyBase58(process.env.DELEGATE_SECRET)
    : (await generateSolanaWallet()).signer;

  console.log(`  owner    ${owner.address}`);
  console.log(`  delegate ${delegate.address}\n`);

  await ensureSol(owner, 'owner');
  await ensureSol(delegate, 'delegate (gas float)');

  const ownerAta = await deriveOwnerDelegationAta(owner.address, NETWORK);
  const delegateAta = await deriveOwnerDelegationAta(delegate.address, NETWORK);

  const ownerUsdc = await usdcBalance(ownerAta);
  if (ownerUsdc === 0n) {
    console.error(
      `\n  Owner ATA ${ownerAta} holds 0 USDC. Fund it via https://faucet.circle.com` +
        ` (Solana Devnet, mint ${USDC_MINT}) then re-run with OWNER_SECRET set.\n`,
    );
    process.exit(1);
  }
  console.log(`  owner USDC balance: ${ownerUsdc} subunits\n`);

  // Ensure the delegate's own ATA exists so pull-to-self transfers land.
  await sendInstructions(delegate, [
    getCreateAssociatedTokenIdempotentInstruction(
      { payer: delegate, ata: delegateAta, owner: delegate.address, mint: USDC_MINT },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    ),
  ]);

  // Cap = min(0.05 USDC, half the balance) so the over-cap test always has room.
  const cap = ownerUsdc < 100_000n ? ownerUsdc / 2n : 50_000n;
  const within = cap / 2n;
  if (within === 0n) {
    bad('cap sizing', 'owner USDC balance too small to test; fund at least a few cents');
    return;
  }

  // 1. approve
  await sendInstructions(
    owner,
    await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: cap,
      network: NETWORK,
    }),
  );
  const afterApprove = await readDelegation(ownerAta);
  if (afterApprove.delegate === delegate.address && afterApprove.remainingCap === cap) {
    ok(`approve: delegate set, remainingCap == cap (${cap})`);
  } else {
    bad('approve', `got delegate=${afterApprove.delegate} remaining=${afterApprove.remainingCap}`);
  }

  // 2. transfer within cap
  await sendInstructions(
    delegate,
    await buildDelegatedTransfer({
      delegate,
      source: ownerAta,
      destination: delegateAta,
      amount: within,
      network: NETWORK,
    }),
  );
  const afterTransfer = await readDelegation(ownerAta);
  if (afterTransfer.remainingCap === cap - within) {
    ok(`transfer within cap: remainingCap ratcheted to ${afterTransfer.remainingCap}`);
  } else {
    bad('transfer within cap', `remaining=${afterTransfer.remainingCap}, expected ${cap - within}`);
  }

  // 3. transfer over remaining cap (reject). Remaining is cap-within; asking for
  // the full cap again is over-remaining - buildDelegatedTransfer produces a
  // valid instruction and the Token program rejects it on-chain.
  await expectReject('transfer over remaining cap is rejected', async () => {
    const overCapIx = await buildDelegatedTransfer({
      delegate,
      source: ownerAta,
      destination: delegateAta,
      amount: cap,
      network: NETWORK,
    });
    return sendInstructions(delegate, overCapIx);
  });

  // 4. delegate cannot escalate
  await expectReject('delegate CANNOT Approve a sub-delegate (owner-only)', () =>
    sendInstructions(delegate, [
      getApproveInstruction({
        source: ownerAta,
        delegate: delegate.address,
        owner: delegate,
        amount: 1n,
      }),
    ]),
  );
  await expectReject('delegate CANNOT SetAuthority(AccountOwner) (owner-only)', () =>
    sendInstructions(delegate, [
      getSetAuthorityInstruction({
        owned: ownerAta,
        owner: delegate,
        authorityType: AuthorityType.AccountOwner,
        newAuthority: delegate.address,
      }),
    ]),
  );
  await expectReject('delegate CANNOT CloseAccount (owner-only)', () =>
    sendInstructions(delegate, [
      getCloseAccountInstruction({
        account: ownerAta,
        destination: delegate.address,
        owner: delegate,
      }),
    ]),
  );

  // 5. fresh approve REPLACES the remaining cap (re-arm, not additive)
  await sendInstructions(
    owner,
    await buildApproveDelegate({
      owner,
      delegate: delegate.address,
      capSubunits: cap,
      network: NETWORK,
    }),
  );
  const afterReArm = await readDelegation(ownerAta);
  if (afterReArm.remainingCap === cap) {
    ok(`re-approve REPLACES remaining cap (re-armed to ${cap}, not ${cap + (cap - within)})`);
  } else {
    bad('re-approve replace', `remaining=${afterReArm.remainingCap}, expected ${cap}`);
  }

  // 6. revoke clears the delegate
  await sendInstructions(owner, await buildRevokeDelegate({ owner, network: NETWORK }));
  const afterRevoke = await readDelegation(ownerAta);
  if (afterRevoke.delegate === null && afterRevoke.remainingCap === 0n) {
    ok('revoke clears the delegate (remainingCap 0)');
  } else {
    bad('revoke', `delegate=${afterRevoke.delegate} remaining=${afterRevoke.remainingCap}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
