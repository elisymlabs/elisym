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
  /**
   * When the job carried a file INPUT, its attachment descriptor (never the
   * bytes). NIP-44's conversation key is symmetric, so the customer can decrypt
   * the file IT sent by treating `promptProviderPubkey` as the counterparty.
   */
  promptAttachment?: FileAttachment;
  /**
   * The agent the input was encrypted to (the `p`-tag recipient) = the decrypt
   * counterparty for `promptAttachment`.
   */
  promptProviderPubkey?: string;
  capability?: string;
  /**
   * When the result was delivered as file(s), the small attachment descriptors
   * (never the bytes). Used to lazily fetch + decrypt each blossom member. One
   * entry for a single-file result, several for a multi-file result.
   */
  resultAttachments?: FileAttachment[];
  /**
   * The result-event author - the sender the blossom file output is decrypted
   * against (the CLI provider wraps the content key with the same identity it
   * signs the result with). Shared by all attachments.
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
