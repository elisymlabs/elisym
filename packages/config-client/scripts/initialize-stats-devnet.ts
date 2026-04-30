/**
 * One-shot script to call `initialize_stats` on the elisym-config program on devnet.
 *
 * Mirrors `initialize-devnet.ts` for the new `NetworkStats` PDA introduced
 * alongside the on-chain stats counter.
 *
 * Usage:
 *   bun run packages/config-client/scripts/initialize-stats-devnet.ts
 *
 * Optional env:
 *   PROGRAM_ID          - defaults to the Codama-embedded program address
 *   RPC_URL             - defaults to https://api.devnet.solana.com
 *   ADMIN_KEYPAIR_PATH  - path to admin keypair JSON; defaults to ~/.config/solana/id.json.
 *                         Must equal the on-chain `Config.admin` (has_one check).
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
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { ELISYM_CONFIG_PROGRAM_ADDRESS, getInitializeStatsInstructionAsync } from '../src';

const PROGRAM_ID: Address = process.env.PROGRAM_ID
  ? address(process.env.PROGRAM_ID)
  : ELISYM_CONFIG_PROGRAM_ADDRESS;

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = RPC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR_PATH ?? join(homedir(), '.config/solana/id.json');

const adminSecretKey = new Uint8Array(JSON.parse(readFileSync(ADMIN_KEYPAIR_PATH, 'utf8')));

async function main(): Promise<void> {
  const admin = await createKeyPairSignerFromBytes(adminSecretKey);

  const [statsPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('network_stats')],
  });
  const [configPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('config')],
  });
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('__event_authority')],
  });

  console.log('RPC:                ', RPC_URL);
  console.log('Program ID:         ', PROGRAM_ID);
  console.log('Admin (signer):     ', admin.address);
  console.log('Config PDA:         ', configPda);
  console.log('Stats PDA:          ', statsPda);
  console.log('Event authority PDA:', eventAuthority);

  const ix = await getInitializeStatsInstructionAsync(
    {
      admin,
      stats: statsPda,
      config: configPda,
      eventAuthority,
      program: PROGRAM_ID,
    },
    { programAddress: PROGRAM_ID },
  );

  const rpc = createSolanaRpc(RPC_URL);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayerSigner(admin, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstruction(ix, msg),
  );
  const signedTx = await signTransactionMessageWithSigners(message);

  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
    commitment: 'confirmed',
  });

  const signature = getSignatureFromTransaction(
    signedTx as Parameters<typeof getSignatureFromTransaction>[0],
  );
  console.log('initialize_stats signature:', signature);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
