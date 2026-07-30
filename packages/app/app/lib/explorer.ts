import { SOLANA_CLUSTER } from './cluster';

/**
 * Explorer URL for a transaction signature, cluster-aware via the app's
 * single cluster switch (no hardcoded cluster strings at call sites).
 */
export function explorerTxUrl(txHash: string): string {
  const suffix = SOLANA_CLUSTER === 'mainnet' ? '' : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/tx/${txHash}${suffix}`;
}
