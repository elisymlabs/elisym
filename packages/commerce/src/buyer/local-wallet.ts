import {
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import type { SolanaWallet } from './solana-pay';

/**
 * A wallet backed by a key in this process (the MCP's agent keypair): it signs
 * exactly the wire transaction it is handed, and nothing else - the core checks
 * the signed bytes as it does a browser wallet's.
 */
export function localSolanaWallet(signer: KeyPairSigner): SolanaWallet {
  return {
    address: signer.address,
    async signTransaction(bytes) {
      const decoded = getTransactionDecoder().decode(bytes);
      const signed = await partiallySignTransaction([signer.keyPair], decoded);
      return new Uint8Array(getTransactionEncoder().encode(signed));
    },
  };
}

/** Chain time from a finalized block (the newest may not have its time yet), in seconds. */
export async function readChainTime(rpc: Rpc<SolanaRpcApi>): Promise<number> {
  const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
  for (let back = 0n; back < 5n; back += 1n) {
    const time = await rpc.getBlockTime(slot - back).send();
    if (time !== null) {
      return Number(time);
    }
  }
  throw new Error('no block time');
}
