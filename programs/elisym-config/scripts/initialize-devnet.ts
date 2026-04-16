/**
 * One-shot scaffold to call `initialize` on a freshly-deployed elisym-config program on devnet.
 *
 * Phase 1c reference only - this script is intentionally minimal and uses raw web3.js v1
 * because Phase 3 will regenerate a typed client via Codama and replace it.
 *
 * Usage:
 *   PROGRAM_ID=<deployed-program-id> \
 *   INITIAL_TREASURY=<treasury-pubkey> \
 *   bun run programs/elisym-config/scripts/initialize-devnet.ts
 *
 * Optional env:
 *   RPC_URL          - defaults to https://api.devnet.solana.com
 *   INITIAL_FEE_BPS  - defaults to 300 (3%)
 *   INITIAL_ADMIN    - defaults to the payer keypair pubkey
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const PROGRAM_ID_RAW = process.env.PROGRAM_ID;
if (!PROGRAM_ID_RAW) {
  console.error('PROGRAM_ID env var is required.');
  process.exit(1);
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_RAW);

const INITIAL_TREASURY_RAW = process.env.INITIAL_TREASURY;
if (!INITIAL_TREASURY_RAW) {
  console.error('INITIAL_TREASURY env var is required.');
  process.exit(1);
}
const INITIAL_TREASURY = new PublicKey(INITIAL_TREASURY_RAW);

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const INITIAL_FEE_BPS = Number(process.env.INITIAL_FEE_BPS ?? '300');
if (!Number.isInteger(INITIAL_FEE_BPS) || INITIAL_FEE_BPS < 0 || INITIAL_FEE_BPS > 1000) {
  console.error(`INITIAL_FEE_BPS must be an integer in [0, 1000]; got ${INITIAL_FEE_BPS}`);
  process.exit(1);
}

const PAYER_KEYPAIR = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8'))),
);

const INITIAL_ADMIN = process.env.INITIAL_ADMIN
  ? new PublicKey(process.env.INITIAL_ADMIN)
  : PAYER_KEYPAIR.publicKey;

const CONFIG_SEED = Buffer.from('config');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

function anchorDiscriminator(globalName: string): Buffer {
  return createHash('sha256').update(`global:${globalName}`).digest().subarray(0, 8);
}

function encodeInitializeData(admin: PublicKey, treasury: PublicKey, feeBps: number): Buffer {
  const discriminator = anchorDiscriminator('initialize');
  const buffer = Buffer.alloc(8 + 32 + 32 + 2);
  discriminator.copy(buffer, 0);
  admin.toBuffer().copy(buffer, 8);
  treasury.toBuffer().copy(buffer, 40);
  buffer.writeUInt16LE(feeBps, 72);
  return buffer;
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const [eventAuthority] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PROGRAM_ID);

  console.log('RPC:                ', RPC_URL);
  console.log('Program ID:         ', PROGRAM_ID.toBase58());
  console.log('Payer:              ', PAYER_KEYPAIR.publicKey.toBase58());
  console.log('Initial admin:      ', INITIAL_ADMIN.toBase58());
  console.log('Initial treasury:   ', INITIAL_TREASURY.toBase58());
  console.log('Initial fee (bps):  ', INITIAL_FEE_BPS);
  console.log('Config PDA:         ', configPda.toBase58());
  console.log('Event authority PDA:', eventAuthority.toBase58());

  const data = encodeInitializeData(INITIAL_ADMIN, INITIAL_TREASURY, INITIAL_FEE_BPS);

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: PAYER_KEYPAIR.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(connection, transaction, [PAYER_KEYPAIR]);
  console.log('Initialize signature:', signature);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
