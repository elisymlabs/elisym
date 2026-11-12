import { ASSISTANT_WRAP_BACKDATE_SECS } from '@elisym/askr';
import { type Ask, type WrapResult, wrapChatMessage } from '@elisym/askr/chat';

export interface OutgoingWrapInput {
  message: Ask;
  senderSecretKey: Uint8Array;
  recipientPubkey: string;
  /** The session end (4.4). */
  expiresAt: number;
  /** Gateway-corrected unix seconds. */
  now: number;
  /** A wrap to the assistant A, which the worker reads with a 10-minute `since` (2.4). */
  toAssistant: boolean;
}

export type OutgoingWrap = WrapResult;

/**
 * Wrap an ask. A wrap to A (first sends and every resend) is backdated by at
 * most 2 minutes (4.1, 2.4); a self-copy to V keeps NIP-59's two days.
 */
export function wrapOutgoing(input: OutgoingWrapInput): OutgoingWrap {
  const base = {
    message: input.message,
    senderSecretKey: input.senderSecretKey,
    recipientPubkey: input.recipientPubkey,
    expiresAt: input.expiresAt,
    now: input.now,
  };
  return wrapChatMessage(
    input.toAssistant ? { ...base, maxBackdateSecs: ASSISTANT_WRAP_BACKDATE_SECS } : base,
  );
}
