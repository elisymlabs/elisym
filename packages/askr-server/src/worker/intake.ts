import {
  type Ask,
  MAX_RUMOR_AGE_SECS,
  type UnwrappedChat,
  checkTicket,
  unwrapChatMessage,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import type { LeasedStore, ServerState, SessionState, StoreRecord } from '../state/types';

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
  | {
      action: 'ask';
      store: StoreRecord;
      epoch: number;
      session: SessionState;
      ask: Ask;
      chat: UnwrappedChat;
    };

/**
 * The 5.8 drop order after the wrap pre-check and the wrap signature (both in
 * the pool's `verifyEvent`): decrypt and seal checks (`unwrapChatMessage`), an
 * ask from a fresh rumor, an id not seen yet, a ticket signed by a known G
 * for this store and issued to the seal's author (only then is the id
 * recorded, so junk without a valid ticket never fills the dedup set, and a
 * copy whose id another intake recorded first is dropped); an expired but
 * otherwise valid ticket is refused with `unavailable: expired`. Everything
 * earlier is silent. The `ask_id` check and the quota and budget transaction
 * follow in the worker.
 */
export async function intakeWrap(
  wrap: NostrEvent,
  leaseOf: (assistant: string) => LeasedStore | undefined,
  state: ServerState,
  gatewayKeys: readonly string[],
  now: number,
): Promise<Intake> {
  const recipient = wrap.tags.find((tag) => tag[0] === 'p')?.[1];
  const lease = recipient === undefined ? undefined : leaseOf(recipient);
  if (!lease) {
    return { action: 'drop' };
  }
  const { store, epoch } = lease;
  const chat = unwrapChatMessage(wrap, store.assistantSecretKey);
  if (!chat || chat.message.type !== 'ask' || chat.recipientPubkey !== store.assistant) {
    return { action: 'drop' };
  }
  // Replays after a restart are never answered (4.1): the rumor's own time is not backdated.
  if (chat.createdAt < now - MAX_RUMOR_AGE_SECS) {
    return { action: 'drop' };
  }
  if (await state.rumorSeen(chat.rumorId, now)) {
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
  if (!(await state.recordRumor(chat.rumorId, now))) {
    return { action: 'drop' };
  }
  const session = await state.session(store.owner, chat.recipientPubkey, chat.senderPubkey, now);
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
  return { action: 'ask', store, epoch, session, ask, chat };
}
