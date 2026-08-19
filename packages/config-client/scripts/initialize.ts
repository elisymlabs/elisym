/**
 * One-shot script to call `initialize` on a freshly-deployed elisym-config program.
 *
 * Network-agnostic: the target cluster is whatever SOLANA_RPC_URL / RPC_URL points at
 * (defaults to the public devnet endpoint). For the mainnet launch sequence see
 * programs/elisym-config/DEPLOY.mainnet.md.
 *
 * Uses the Codama-generated client from @elisym/config-client and @solana/kit.
 *
 * Usage:
 *   INITIAL_TREASURY=<treasury-pubkey> \
 *   bun run packages/config-client/scripts/initialize.ts
 *
 * Optional env:
 *   PROGRAM_ID         - defaults to the Codama-embedded program address
 *   SOLANA_RPC_URL     - RPC endpoint (alias: RPC_URL); defaults to https://api.devnet.solana.com
 *   INITIAL_FEE_BPS    - defaults to 300 (3%)
 *   INITIAL_ADMIN      - defaults to the payer keypair pubkey
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
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getInitializeInstructionAsync, ELISYM_CONFIG_PROGRAM_ADDRESS } from '../src';

const PROGRAM_ID: Address = process.env.PROGRAM_ID
  ? address(process.env.PROGRAM_ID)
  : ELISYM_CONFIG_PROGRAM_ADDRESS;

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = address('BPFLoaderUpgradeab1e11111111111111111111111');

const INITIAL_TREASURY_RAW = process.env.INITIAL_TREASURY;
if (!INITIAL_TREASURY_RAW) {
  console.error('INITIAL_TREASURY env var is required.');
  process.exit(1);
}
const INITIAL_TREASURY = address(INITIAL_TREASURY_RAW);

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = RPC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

const INITIAL_FEE_BPS = Number(process.env.INITIAL_FEE_BPS ?? '300');
if (!Number.isInteger(INITIAL_FEE_BPS) || INITIAL_FEE_BPS < 0 || INITIAL_FEE_BPS > 1000) {
  console.error(`INITIAL_FEE_BPS must be an integer in [0, 1000]; got ${INITIAL_FEE_BPS}`);
  process.exit(1);
}

const payerSecretKey = new Uint8Array(
  JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8')),
);

async function main(): Promise<void> {
  const payer = await createKeyPairSignerFromBytes(payerSecretKey);

  const INITIAL_ADMIN: Address = process.env.INITIAL_ADMIN
    ? address(process.env.INITIAL_ADMIN)
    : payer.address;

  const [configPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('config')],
  });
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('__event_authority')],
  });
  // `initialize` requires the payer to be the program's upgrade authority, so
  // the loader's ProgramData account rides along. Derived from PROGRAM_ID here
  // rather than left to the generated client, whose fallback hardcodes the
  // Codama-embedded address and would derive the wrong account under a
  // PROGRAM_ID override.
  const [programData] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    seeds: [getAddressEncoder().encode(PROGRAM_ID)],
  });

  console.log('RPC:                ', RPC_URL);
  console.log('Program ID:         ', PROGRAM_ID);
  console.log('Payer:              ', payer.address);
  console.log('Initial admin:      ', INITIAL_ADMIN);
  console.log('Initial treasury:   ', INITIAL_TREASURY);
  console.log('Initial fee (bps):  ', INITIAL_FEE_BPS);
  console.log('Config PDA:         ', configPda);
  console.log('Event authority PDA:', eventAuthority);
  console.log('ProgramData PDA:    ', programData);

  const ix = await getInitializeInstructionAsync(
    {
      payer,
      programData,
      eventAuthority,
      program: PROGRAM_ID,
      admin: INITIAL_ADMIN,
      treasury: INITIAL_TREASURY,
      feeBps: INITIAL_FEE_BPS,
    },
    { programAddress: PROGRAM_ID },
  );

  const rpc = createSolanaRpc(RPC_URL);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayerSigner(payer, msg),
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
  console.log('Initialize signature:', signature);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
