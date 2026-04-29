import type { PaymentAssetRef } from '@elisym/sdk';
import type { useBuyForCard } from '~/contexts/BuyContext';

export type BuyState = NonNullable<ReturnType<typeof useBuyForCard>>;

export interface Artifact {
  id: string;
  cardName: string;
  result: string;
  createdAt: number;
  /** Raw amount in subunits of `asset` (lamports for SOL, 1e-6 for USDC). */
  priceLamports?: number;
  /** Payment asset descriptor. Undefined => native SOL (back-compat). */
  asset?: PaymentAssetRef;
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
