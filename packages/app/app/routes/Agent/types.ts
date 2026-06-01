import type { FileAttachment, PaymentAssetRef } from '@elisym/sdk';
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
  /**
   * When the result was delivered as a file, the small attachment descriptor
   * (never the bytes). Used to lazily fetch + decrypt the blossom member.
   */
  resultAttachment?: FileAttachment;
  /**
   * The result-event author - the sender the blossom file output is decrypted
   * against (the CLI provider wraps the content key with the same identity it
   * signs the result with).
   */
  resultProviderPubkey?: string;
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
