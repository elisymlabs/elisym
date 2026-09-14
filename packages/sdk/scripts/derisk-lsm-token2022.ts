#!/usr/bin/env bun
/**
 * Phase 0 de-risk for LSM payments (docs/plans/lsm-payments.md): prove that the
 * RUNTIME payment-path builders - `@solana-program/token` (classic package)
 * with explicit `tokenProgram` / `programAddress` overrides - drive a
 * Token-2022 mint end-to-end on live devnet. This is exactly what
 * `buildPaymentInstructions` will do; the spike must stay green before any SDK
 * wiring lands.
 *
 *   LSM_DEVNET_MINT=<mint> bun packages/sdk/scripts/derisk-lsm-token2022.ts
 *
 * The known devnet Token-2022 test mint (created 2026-08-15, unregistered -
 * NOT in KNOWN_ASSETS; LSM itself is mainnet-only) is
 * EWyZVZ7igQnp3PzhNCcFJahZGdVMEefb15DmHA6H2Rek. Its mint authority is the ops
 * deployer key; `spl-token transfer/mint` against it works for funding.
 *
 * The operator key (holds devnet LSM, pays fees) is read from OWNER_SECRET
 * (base58) or OWNER_KEYPAIR_FILE (Solana CLI JSON, default
 * ~/.config/solana/id.json). Verifies:
 *  1. t22 ATA derivation via `findAssociatedTokenPda` with a `tokenProgram`
 *     override differs from the classic derivation;
 *  2. `getMinimumBalanceForRentExemption(170)` matches the plan's 2_074_080
 *     figure for a t22 ATA (165 base + 1 account type + 4 ImmutableOwner TLV);
 *  3. `CreateAssociatedTokenIdempotent` with the t22 `tokenProgram` input
 *     creates a fresh recipient ATA (and is idempotent on re-run);
 *  4. `TransferChecked` built by the classic package with
 *     `{ programAddress: TOKEN_2022 }` - carrying the payment-path marker
 *     accounts (reference + protocol tag) - moves LSM and the balance reads
 *     back correctly.
 */

import { readFileSync } from 'node:fs';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  type Address,
  type KeyPairSigner,
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { ELISYM_PROTOCOL_TAG } from '../src/constants';
import { signerFromSecretKeyBase58 } from '../src/payment/wallet';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = process.env.SOLANA_WS_URL ?? 'wss://api.devnet.solana.com';

const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const LSM_DECIMALS = 6;
const EXPECTED_T22_ATA_RENT = 2_074_080n;
const T22_ATA_ACCOUNT_SIZE = 170n;
const TRANSFER_SUBUNITS = 1_000n;

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

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

async function loadOperator(): Promise<KeyPairSigner> {
  if (process.env.OWNER_SECRET) {
    return signerFromSecretKeyBase58(process.env.OWNER_SECRET);
  }
  const keypairFile =
    process.env.OWNER_KEYPAIR_FILE ?? `${process.env.HOME ?? ''}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(keypairFile, 'utf8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(raw));
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

async function tokenBalance(ata: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  const mintFromEnv = process.env.LSM_DEVNET_MINT;
  if (!mintFromEnv) {
    console.error('  Set LSM_DEVNET_MINT to the devnet LSM mint address.');
    process.exit(1);
  }
  const mint = address(mintFromEnv);
  const operator = await loadOperator();
  console.log(`\nLSM Token-2022 de-risk via classic-package builders (${RPC_URL})`);
  console.log(`  mint     ${mint}`);
  console.log(`  operator ${operator.address}\n`);

  // 1. ATA derivation with tokenProgram override.
  const [operatorT22Ata] = await findAssociatedTokenPda({
    owner: operator.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint,
  });
  const [operatorClassicAta] = await findAssociatedTokenPda({
    owner: operator.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  if (operatorT22Ata !== operatorClassicAta) {
    ok(`t22 ATA derivation differs from classic (${operatorT22Ata})`);
  } else {
    bad('t22 ATA derivation', 'classic and t22 derivations returned the same address');
  }

  const operatorBalance = await tokenBalance(operatorT22Ata);
  if (operatorBalance >= TRANSFER_SUBUNITS) {
    ok(`operator t22 ATA holds ${operatorBalance} LSM subunits`);
  } else {
    bad(
      'operator LSM balance',
      `need at least ${TRANSFER_SUBUNITS} subunits; fund via 'spl-token mint/transfer' against the devnet test mint (see header comment)`,
    );
    process.exit(1);
  }

  // 2. Rent figure for a t22 ATA (ImmutableOwner is mandatory on t22 ATAs).
  const rent = await rpc.getMinimumBalanceForRentExemption(T22_ATA_ACCOUNT_SIZE).send();
  if (rent === EXPECTED_T22_ATA_RENT) {
    ok(`rent(${T22_ATA_ACCOUNT_SIZE}) == ${EXPECTED_T22_ATA_RENT} lamports`);
  } else {
    bad(
      't22 ATA rent',
      `rent(${T22_ATA_ACCOUNT_SIZE}) == ${rent}, expected ${EXPECTED_T22_ATA_RENT}`,
    );
  }

  // 3 + 4. Fresh recipient: idempotent ATA create + TransferChecked with the
  // payment-path marker accounts, all built by the classic package.
  const recipient = await generateKeyPairSigner();
  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint,
  });
  const reference = await generateKeyPairSigner();
  const protocolTag = address(ELISYM_PROTOCOL_TAG);

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction(
    {
      payer: operator,
      ata: recipientAta,
      owner: recipient.address,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM,
    },
    { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
  );
  const transferIx = getTransferCheckedInstruction(
    {
      source: operatorT22Ata,
      mint,
      destination: recipientAta,
      authority: operator,
      amount: TRANSFER_SUBUNITS,
      decimals: LSM_DECIMALS,
    },
    { programAddress: TOKEN_2022_PROGRAM },
  );
  const transferIxWithMarkers = {
    ...transferIx,
    accounts: [
      ...transferIx.accounts,
      { address: reference.address, role: AccountRole.READONLY },
      { address: protocolTag, role: AccountRole.READONLY },
    ],
  };

  const signature = await sendInstructions(operator, [createAtaIx, transferIxWithMarkers]);
  console.log(`  tx ${signature}`);

  const recipientBalance = await tokenBalance(recipientAta);
  if (recipientBalance === TRANSFER_SUBUNITS) {
    ok(`TransferChecked moved ${TRANSFER_SUBUNITS} subunits (recipient ATA ${recipientAta})`);
  } else {
    bad('TransferChecked', `recipient balance ${recipientBalance}, expected ${TRANSFER_SUBUNITS}`);
  }

  // Idempotency: repeating the create for an existing ATA must not fail.
  await sendInstructions(operator, [createAtaIx]);
  ok('CreateAssociatedTokenIdempotent is idempotent on an existing t22 ATA');

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
