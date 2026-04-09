/**
 * NIP-44 encryption/decryption helpers.
 * Wraps nostr-tools nip44 v2 for convenience.
 */
import * as nip44 from 'nostr-tools/nip44';

/** Encrypt plaintext using NIP-44 v2 (sender secret key + recipient public key). */
export function nip44Encrypt(
  plaintext: string,
  senderSk: Uint8Array,
  recipientPubkey: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(senderSk, recipientPubkey);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/** Decrypt ciphertext using NIP-44 v2 (receiver secret key + sender public key). */
export function nip44Decrypt(
  ciphertext: string,
  receiverSk: Uint8Array,
  senderPubkey: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(receiverSk, senderPubkey);
  return nip44.v2.decrypt(ciphertext, conversationKey);
}
