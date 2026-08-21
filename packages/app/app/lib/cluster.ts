import type { ProtocolCluster } from '@elisym/sdk';

export type SolanaCluster = 'devnet' | 'mainnet';

/** The only hostname that serves mainnet (exact-host allowlist, plan D10). */
const MAINNET_HOSTNAME = 'app.elisym.network';

/** Cross-domain switch targets - switching networks = following a link (D10/D11). */
export const MAINNET_APP_URL = `https://${MAINNET_HOSTNAME}`;
export const DEVNET_APP_URL = 'https://app-dev.elisym.network';

/**
 * Resolve the cluster from the page hostname. Mainnet ONLY on the exact
 * production host; everything else - app-dev.elisym.network, localhost,
 * 127.0.0.1, LAN IPs, *.vercel.app previews, unknown hosts - fails safe to
 * devnet, so a preview URL can never surface real-money prompts (plan D10).
 */
export function resolveCluster(hostname: string): SolanaCluster {
  return hostname === MAINNET_HOSTNAME ? 'mainnet' : 'devnet';
}

// The undefined-window branch (the app's vitest runs in a node environment)
// is the same fail-safe-to-devnet rule as an unknown hostname. Fixed per page
// load - the module-level RPC/program-id singletons derived from it are safe.
export const SOLANA_CLUSTER: SolanaCluster =
  typeof window === 'undefined' ? 'devnet' : resolveCluster(window.location.hostname);

const PUBLIC_RPC_URLS: Record<SolanaCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

/**
 * The RPC endpoint for a cluster, overridable at build time.
 *
 * The public endpoints are only a fallback, and the mainnet one does not work
 * from a browser at all: `api.mainnet-beta.solana.com` answers 403 to any
 * request carrying an `Origin` header. A mainnet deployment MUST therefore set
 * `VITE_SOLANA_RPC_URL_MAINNET` to a provider endpoint, or every on-chain read
 * fails - starting with the protocol config, which gates all payments.
 *
 * One variable per cluster, never a shared one: a single override set for
 * production would point the devnet origin at a mainnet endpoint. This does not
 * loosen the D10 hostname allowlist - the cluster is still decided by the host,
 * and only its endpoint is configurable.
 *
 * The key ships in the bundle, as any browser-side RPC credential must.
 * Restrict it by allowed origin at the provider.
 */
export function rpcUrlFor(cluster: SolanaCluster): string {
  const override =
    cluster === 'mainnet'
      ? import.meta.env.VITE_SOLANA_RPC_URL_MAINNET
      : import.meta.env.VITE_SOLANA_RPC_URL_DEVNET;
  return override && override.length > 0 ? override : PUBLIC_RPC_URLS[cluster];
}

export const SOLANA_RPC_URL = rpcUrlFor(SOLANA_CLUSTER);

if (SOLANA_CLUSTER === 'mainnet' && !import.meta.env.VITE_SOLANA_RPC_URL_MAINNET) {
  // Loud on purpose: the fallback is not merely slow here, it is refused
  // outright, and the failure surfaces later as an opaque config-fetch error.
  console.warn(
    'VITE_SOLANA_RPC_URL_MAINNET is not set - falling back to api.mainnet-beta.solana.com, ' +
      'which answers 403 to browser requests. On-chain reads and payments will fail.',
  );
}

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
