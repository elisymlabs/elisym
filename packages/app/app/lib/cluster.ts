import type { ProtocolCluster } from '@elisym/sdk';

export type SolanaCluster = 'devnet' | 'mainnet';

export const SOLANA_CLUSTER: SolanaCluster = 'devnet';

const RPC_URLS: Record<SolanaCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};
export const SOLANA_RPC_URL = RPC_URLS[SOLANA_CLUSTER];

// Wallet Standard chain identifier. Phantom and Solflare expose
// `accounts[0].chains` from `@wallet-standard/base`; the array reflects the
// clusters the wallet is currently allowed to sign for. We check membership
// to detect a network mismatch between the app and the connected wallet.
const WALLET_STANDARD_CHAINS: Record<SolanaCluster, string> = {
  devnet: 'solana:devnet',
  mainnet: 'solana:mainnet',
};
export const SOLANA_CHAIN_ID = WALLET_STANDARD_CHAINS[SOLANA_CLUSTER];

const CLUSTER_LABELS: Record<SolanaCluster, string> = {
  devnet: 'Devnet',
  mainnet: 'Mainnet',
};
export const SOLANA_CLUSTER_LABEL = CLUSTER_LABELS[SOLANA_CLUSTER];

const SDK_CLUSTERS: Record<SolanaCluster, ProtocolCluster> = {
  devnet: 'devnet',
  mainnet: 'mainnet',
};
export const SDK_CLUSTER = SDK_CLUSTERS[SOLANA_CLUSTER];
