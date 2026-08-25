/// <reference types="vite/client" />

/**
 * Build-time configuration. Both are optional and fall back to the public
 * Solana endpoints, but `VITE_SOLANA_RPC_URL_MAINNET` is effectively required
 * for a mainnet deployment - see `rpcUrlFor` in `app/lib/cluster.ts`.
 */
interface ImportMetaEnv {
  readonly VITE_SOLANA_RPC_URL_MAINNET?: string;
  readonly VITE_SOLANA_RPC_URL_DEVNET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
