import type { ElisymIdentity } from '@elisym/sdk';
import type { ElisymConfig } from './environment';

export type ElisymMode = 'customer' | 'provider' | 'both';
export type ElisymNetwork = 'devnet' | 'mainnet';

export type JobStatus =
  | 'pending'
  | 'payment-required'
  | 'paying'
  | 'paid'
  | 'processing'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ActiveJob {
  id: string;
  status: JobStatus;
  providerPubkey: string;
  lamports: bigint;
  capability: string;
  createdAt: number;
  lastUpdate: number;
  errorMessage?: string;
  resultContent?: string;
  txSignature?: string;
  cleanup?: () => void;
  releaseReservation?: () => void;
}

export interface PendingApproval {
  jobId: string;
  providerPubkey: string;
  lamports: bigint;
  expiresAt: number;
}

export interface ElisymState {
  config: ElisymConfig;
  activeJobs: Map<string, ActiveJob>;
  lastDiscovery: {
    query: string;
    candidates: Array<{
      pubkey: string;
      name?: string;
      capabilities: string[];
      priceLamports?: bigint;
      address?: string;
    }>;
    ts: number;
  } | null;
  identity?: ElisymIdentity;
}

export type { ElisymConfig };
export type { ElisymIdentity } from '@elisym/sdk';
