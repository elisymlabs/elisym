import {
  type Ask,
  MAX_RUMOR_AGE_SECS,
  type UnwrappedChat,
  checkTicket,
  unwrapChatMessage,
} from '@elisym/comcore';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import type { ServerState, SessionState, StoreRecord } from '../state/types';

export type Intake =
  | { action: 'drop' }
  | {
      action: 'unavailable';
      reason: 'expired';
      store: StoreRecord;
      visitor: string;
      askId: string;
      sessionEnd: number;
    }
  | { action: 'ask'; store: StoreRecord; session: SessionState; ask: Ask; chat: UnwrappedChat };

/**
 * The 5.8 drop order after the wrap pre-check and the wrap signature (both in
 * the pool's `verifyEvent`): decrypt and seal checks (`unwrapChatMessage`), an
 * ask from a fresh rumor, an id not seen yet, a ticket signed by a known G
 * for this store and issued to the seal's author (only then is the id
 * recorded, so junk without a valid ticket never fills the dedup set); an expired but
 * otherwise valid ticket is refused with `unavailable: expired`. Everything
 * earlier is silent. The `ask_id` check and the quota and budget transaction
 * follow in the worker.
 */
export function intakeWrap(
  wrap: NostrEvent,
  state: ServerState,
  gatewayKeys: readonly string[],
  now: number,
): Intake {
  const recipient = wrap.tags.find((tag) => tag[0] === 'p')?.[1];
  const store = recipient === undefined ? undefined : state.storeByAssistant(recipient);
  if (!store || store.status !== 'active') {
    return { action: 'drop' };
  }
  const chat = unwrapChatMessage(wrap, store.assistantSecretKey);
  if (
    !chat ||
    chat.message.type !== 'ask' ||
    chat.recipientPubkey !== getPublicKey(store.assistantSecretKey)
  ) {
    return { action: 'drop' };
  }
  // Replays after a restart are never answered (4.1): the rumor's own time is not backdated.
  if (chat.createdAt < now - MAX_RUMOR_AGE_SECS) {
    return { action: 'drop' };
  }
  if (state.rumorSeen(chat.rumorId, now)) {
    return { action: 'drop' };
  }
  const ask = chat.message;
  const check = checkTicket(ask.ticket, {
    gatewayKeys,
    store: store.owner,
    sender: chat.senderPubkey,
    now,
  });
  if (check === 'invalid') {
    return { action: 'drop' };
  }
  state.recordRumor(chat.rumorId, now);
  const session = state.session(chat.recipientPubkey, chat.senderPubkey, now);
  if (check === 'expired') {
    return {
      action: 'unavailable',
      reason: 'expired',
      store,
      visitor: chat.senderPubkey,
      askId: ask.ask_id,
      sessionEnd: session.sessionEnd,
    };
  }
  return { action: 'ask', store, session, ask, chat };
}
