/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Askr API base for a local end-to-end run; the public host otherwise. */
  readonly VITE_ASKR_API_BASE?: string;
  /** The relay to read from for a local end-to-end run; the Askr relay otherwise. */
  readonly VITE_ASKR_RELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
