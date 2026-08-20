/**
 * Admin CLI for the elisym-config on-chain program.
 *
 * Usage:
 *   bun run packages/config-client/scripts/admin.ts <command> [args]
 *
 * Commands:
 *   show                          - display current on-chain config
 *   set-fee <bps>                 - update protocol fee (0-1000)
 *   set-treasury <pubkey>         - update treasury address
 *   propose-admin <pubkey>        - propose a new admin (two-step transfer)
 *   accept-admin                  - accept admin role (run from new admin wallet)
 *   cancel-pending-admin          - cancel a pending admin transfer
 *
 * Optional env:
 *   PROGRAM_ID  - defaults to Codama-embedded program address
 *   SOLANA_RPC_URL - RPC endpoint (alias: RPC_URL); defaults to https://api.devnet.solana.com
 *   KEYPAIR     - path to keypair JSON, defaults to ~/.config/solana/id.json
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
import {
  ELISYM_CONFIG_PROGRAM_ADDRESS,
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  fetchMaybeConfig,
  fetchMaybeAssetStats,
  fetchMaybeNetworkStats,
  getAcceptAdminInstructionAsync,
  getCancelPendingAdminInstructionAsync,
  getProposeAdminInstructionAsync,
  getSetFeeBpsInstructionAsync,
  getSetTreasuryInstructionAsync,
} from '../src';

const COMMANDS = [
  'show',
  'set-fee',
  'set-treasury',
  'propose-admin',
  'accept-admin',
  'cancel-pending-admin',
] as const;
type Command = (typeof COMMANDS)[number];

const PROGRAM_ID: Address = process.env.PROGRAM_ID
  ? address(process.env.PROGRAM_ID)
  : ELISYM_CONFIG_PROGRAM_ADDRESS;

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const WS_URL = RPC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

// Resolved at module load: `show` prints it before its first fetch, and it -
// not the RPC URL - selects which mints the AssetStats block checks.
const NETWORK_ENV = process.env.SOLANA_NETWORK ?? 'devnet';
if (NETWORK_ENV !== 'devnet' && NETWORK_ENV !== 'mainnet') {
  console.error(`SOLANA_NETWORK must be 'devnet' or 'mainnet'; got "${NETWORK_ENV}".`);
  process.exit(1);
}
const network = NETWORK_ENV;

const KEYPAIR_PATH = process.env.KEYPAIR ?? join(homedir(), '.config/solana/id.json');

function usage(): never {
  console.error('Usage: bun run admin.ts <command> [args]');
  console.error('Commands: show, set-fee <bps>, set-treasury <pubkey>,');
  console.error('          propose-admin <pubkey>, accept-admin, cancel-pending-admin');
  process.exit(1);
}

async function sendTransaction(
  ix: Parameters<typeof appendTransactionMessageInstruction>[0],
  payer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
): Promise<string> {
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

  return getSignatureFromTransaction(signedTx as Parameters<typeof getSignatureFromTransaction>[0]);
}

/**
 * An RPC endpoint safe to print: scheme and host only. The path is dropped
 * along with the query string and credentials - Alchemy and QuickNode carry
 * the API key IN THE PATH, so keeping it to disambiguate path-selected
 * clusters would trade a credential for a label. `resolveCluster` below
 * answers the cluster question properly instead.
 */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(unparseable RPC URL)';
  }
}

/**
 * Genesis hash per cluster - the only identity a URL cannot lie about.
 * `getGenesisHash` is one read-only call and it costs nothing to be sure.
 */
const GENESIS_HASHES: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

/**
 * Which cluster actually answered, asked of the chain rather than inferred
 * from the endpoint string. An origin cannot identify a cluster - providers
 * select it by path or by subdomain, and the path is exactly where Alchemy and
 * QuickNode put the API key, so it must not be printed.
 */
async function resolveCluster(rpc: ReturnType<typeof createSolanaRpc>): Promise<string> {
  try {
    const genesis = await rpc.getGenesisHash().send();
    return GENESIS_HASHES[genesis] ?? `unknown (genesis ${genesis})`;
  } catch {
    return '(could not read genesis hash)';
  }
}

async function show(): Promise<void> {
  const rpc = createSolanaRpc(RPC_URL);
  const [configPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('config')],
  });

  // Identity BEFORE any fetch. `show` is the release gate and the state it is
  // most often run in is "something failed and I do not know what landed" - so
  // it must never die before saying which cluster and program it is reading.
  // The program id is identical on both clusters and RPC_URL defaults to
  // devnet when SOLANA_RPC_URL is unset, so the board is meaningless without
  // these lines. `network` is separate from the cluster on purpose: it, not
  // the endpoint, selects which mints the AssetStats block below checks - and
  // a disagreement between the two is what silently produced orphan PDAs and a
  // falsely-green gate, so it is called out rather than left to the reader.
  const cluster = await resolveCluster(rpc);
  console.log('RPC:           ', redactRpcUrl(RPC_URL));
  console.log('Cluster:       ', cluster, '(from genesis hash)');
  console.log('SOLANA_NETWORK:', network);
  if (cluster !== network) {
    console.log('');
    console.log(`*** MISMATCH: SOLANA_NETWORK=${network} but the RPC answered ${cluster}. ***`);
    console.log('*** Everything below describes the WRONG cluster. Do not gate a release on it.');
    console.log('');
  }
  console.log('Program ID:    ', PROGRAM_ID);
  console.log('Config PDA:    ', configPda);

  // `fetchMaybeConfig`, not `fetchConfig`: the asserting variant throws before
  // anything is printed when the config is absent, which is exactly the
  // post-failed-`initialize` state an operator runs this to diagnose. A
  // missing config also must not hide the rest - `create_asset_stats` takes no
  // config account, so 3b can have landed while step 2 has not.
  const account = await fetchMaybeConfig(rpc, configPda);
  if (!account.exists) {
    console.log('Config:         (MISSING - initialize has not landed on this cluster)');
  } else {
    const data = account.data;
    const pendingAdmin = data.pendingAdmin.__option === 'Some' ? data.pendingAdmin.value : 'none';
    console.log('Version:       ', data.version);
    console.log('Admin:         ', data.admin);
    console.log('Pending admin: ', pendingAdmin);
    console.log('Treasury:      ', data.treasury);
    console.log('Fee (bps):     ', data.feeBps, `(${(data.feeBps / 100).toFixed(2)}%)`);
    console.log('Paused:        ', data.paused);
    console.log('Last updated:  ', new Date(Number(data.lastUpdated) * 1000).toISOString());
  }

  // Every payment tx bundles increment_stats - a missing stats PDA fails all
  // payments on this cluster, and the config account alone cannot reveal that.
  const [statsPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('network_stats')],
  });
  const statsAccount = await fetchMaybeNetworkStats(rpc, statsPda);
  if (statsAccount.exists) {
    console.log('Stats PDA:     ', statsPda, '(initialized)');
    console.log('Job count:     ', statsAccount.data.jobCount);
  } else {
    console.log(
      'Stats PDA:     ',
      statsPda,
      '(MISSING - run initialize-stats.ts, payments will fail until it exists)',
    );
  }

  // Per-mint AssetStats PDAs for the network's assets (SOLANA_NETWORK env,
  // default devnet - explicit by design, never inferred from the RPC URL).
  // A missing PDA on a program that HAS increment_stats_v2 only costs the
  // first payer ~0.0019 SOL of rent (the instruction self-registers). On a
  // program that predates the instruction it means every payment fails, and
  // the two look identical from here - hence the message below points at the
  // release gate rather than just at the rent.
  const assetTargets: Array<{ label: string; mint: string }> = [
    { label: 'native (sentinel)', mint: NATIVE_ASSET_SENTINEL },
    {
      label: `USDC ${network}`,
      mint:
        network === 'mainnet'
          ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
          : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    },
    ...(network === 'mainnet'
      ? [{ label: 'LSM mainnet', mint: '86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump' }]
      : []),
  ];
  for (const target of assetTargets) {
    const assetStatsPda = await deriveAssetStatsAddress(PROGRAM_ID, address(target.mint));
    const assetAccount = await fetchMaybeAssetStats(rpc, assetStatsPda);
    console.log(
      `AssetStats ${target.label}:`,
      assetStatsPda,
      assetAccount.exists
        ? `(exists, volume ${assetAccount.data.volume})`
        : '(MISSING - run create-asset-stats.ts; if that aborts with ' +
            'InstructionFallbackNotFound the program predates increment_stats_v2 and the ' +
            'SDK must NOT be released against it)',
    );
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !COMMANDS.includes(command as Command)) {
    usage();
  }

  if (command === 'show') {
    await show();
    return;
  }

  const payerSecretKey = new Uint8Array(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')));
  const payer = await createKeyPairSignerFromBytes(payerSecretKey);
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('__event_authority')],
  });
  const programOpts = { programAddress: PROGRAM_ID };

  console.log('RPC:    ', redactRpcUrl(RPC_URL));
  console.log('Signer: ', payer.address);

  let signature: string;

  switch (command as Command) {
    case 'set-fee': {
      const bps = Number(args[0]);
      if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
        console.error('set-fee requires an integer in [0, 1000]');
        process.exit(1);
      }
      const ix = await getSetFeeBpsInstructionAsync(
        { admin: payer, eventAuthority, program: PROGRAM_ID, newBps: bps },
        programOpts,
      );
      signature = await sendTransaction(ix, payer);
      console.log(`Fee updated to ${bps} bps. Signature: ${signature}`);
      break;
    }

    case 'set-treasury': {
      if (!args[0]) {
        console.error('set-treasury requires a pubkey argument');
        process.exit(1);
      }
      const ix = await getSetTreasuryInstructionAsync(
        { admin: payer, eventAuthority, program: PROGRAM_ID, newTreasury: address(args[0]) },
        programOpts,
      );
      signature = await sendTransaction(ix, payer);
      console.log(`Treasury updated. Signature: ${signature}`);
      break;
    }

    case 'propose-admin': {
      if (!args[0]) {
        console.error('propose-admin requires a pubkey argument');
        process.exit(1);
      }
      const ix = await getProposeAdminInstructionAsync(
        { admin: payer, eventAuthority, program: PROGRAM_ID, newAdmin: address(args[0]) },
        programOpts,
      );
      signature = await sendTransaction(ix, payer);
      console.log(`Admin transfer proposed to ${args[0]}. Signature: ${signature}`);
      console.log('The new admin must run "accept-admin" to complete the transfer.');
      break;
    }

    case 'accept-admin': {
      const ix = await getAcceptAdminInstructionAsync(
        { newAdmin: payer, eventAuthority, program: PROGRAM_ID },
        programOpts,
      );
      signature = await sendTransaction(ix, payer);
      console.log(`Admin role accepted. Signature: ${signature}`);
      break;
    }

    case 'cancel-pending-admin': {
      const ix = await getCancelPendingAdminInstructionAsync(
        { admin: payer, eventAuthority, program: PROGRAM_ID },
        programOpts,
      );
      signature = await sendTransaction(ix, payer);
      console.log(`Pending admin transfer cancelled. Signature: ${signature}`);
      break;
    }

    default:
      usage();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
