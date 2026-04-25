import type { PaymentAssetRef } from '@elisym/sdk';
import type { useBuyCapability } from '~/hooks/useBuyCapability';

export type BuyState = ReturnType<typeof useBuyCapability>;

export interface Artifact {
  id: string;
  cardName: string;
  result: string;
  createdAt: number;
  priceLamports?: number;
  prompt?: string;
  capability?: string;
}

export interface ActivityEvent {
  id: string;
  createdAt: number;
  capability?: string;
  /** Raw amount in subunits of `asset` (lamports for SOL, 1e-6 for USDC). */
  amount?: number;
  /** Asset descriptor parsed from the payment request. Undefined => native SOL. */
  asset?: PaymentAssetRef;
}
