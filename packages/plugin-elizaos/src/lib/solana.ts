import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import bs58 from 'bs58';
import { DEFAULT_DEVNET_RPC, DEFAULT_MAINNET_RPC } from '../constants';
import type { ElisymNetwork } from '../types';

export function resolveRpcUrl(network: ElisymNetwork, override?: string): string {
  if (override && override.length > 0) {
    return override;
  }
  return network === 'mainnet' ? DEFAULT_MAINNET_RPC : DEFAULT_DEVNET_RPC;
}

export function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

export function createRpc(httpUrl: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(httpUrl);
}

export async function signerFromBase58(base58: string): Promise<KeyPairSigner> {
  const bytes = bs58.decode(base58);
  if (bytes.length !== 64) {
    throw new Error('Solana secret key must decode to 64 bytes');
  }
  return createKeyPairSignerFromBytes(bytes);
}

export async function getBalanceLamports(
  rpc: Rpc<SolanaRpcApi>,
  signer: KeyPairSigner,
): Promise<bigint> {
  const { value } = await rpc.getBalance(address(signer.address)).send();
  return BigInt(value);
}
