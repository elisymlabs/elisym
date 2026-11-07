/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** cloud-api's origin; unset, the admin is for self-hosted stores only. */
  readonly VITE_CLOUD_API_ORIGIN: string | undefined;
  /** The Pay Core page a cloud plan is paid on in stablecoins (optional). */
  readonly VITE_BILLING_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
