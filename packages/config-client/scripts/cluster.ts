/**
 * Which cluster is actually on the other end of the RPC endpoint.
 *
 * Shared by the ops scripts that declare a `SOLANA_NETWORK`: the declared
 * network selects which mints and which PDAs they touch, while the endpoint
 * selects which chain they touch, and nothing ties the two together. An origin
 * cannot identify a cluster either - providers select it by path or by
 * subdomain, and the path is exactly where Alchemy and QuickNode put the API
 * key, so it must not be printed. The genesis hash is the one identity a URL
 * cannot lie about.
 */
import type { createSolanaRpc } from '@solana/kit';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

const GENESIS_HASHES: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

/**
 * The cluster that answered, asked of the chain. `getGenesisHash` is one
 * read-only call and it costs nothing to be sure. Returns a human-readable
 * marker rather than throwing when the endpoint cannot answer - a read-only
 * caller still wants to print the rest of its board.
 */
export async function resolveCluster(rpc: SolanaRpc): Promise<string> {
  try {
    const genesis = await rpc.getGenesisHash().send();
    return GENESIS_HASHES[genesis] ?? `unknown (genesis ${genesis})`;
  } catch {
    return '(could not read genesis hash)';
  }
}

/**
 * Refuse to sign when the cluster that answered is not the one the operator
 * declared. `admin.ts show` only warns - it is read-only and its whole job is
 * to print the board it was run to read. A mutation has no such excuse:
 * `set-treasury` or `set-fee` against the wrong chain is a real transaction
 * with real money behind it, and the two clusters are one stale shell variable
 * apart. An unreadable or unrecognised genesis hash aborts too: an unproven
 * cluster is not the declared one.
 */
export function abortOnClusterMismatch(cluster: string, network: string): void {
  if (cluster === network) {
    return;
  }
  console.error('');
  console.error(`*** ABORT: SOLANA_NETWORK=${network} but the RPC answered ${cluster}. ***`);
  console.error('*** Refusing to sign against a cluster you did not ask for.');
  console.error('*** Fix SOLANA_RPC_URL (or SOLANA_NETWORK) and re-run.');
  process.exit(1);
}
