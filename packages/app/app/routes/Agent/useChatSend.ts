import type { CapabilityCard } from '@elisym/sdk';
import { useCallback } from 'react';
import { useBuy } from '~/contexts/BuyContext';
import { useIdentity } from '~/hooks/useIdentity';
import { resolveSessionForSend } from '~/lib/chatSession';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { sessionCandidatesOf } from './useChatThread';

interface Args {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
}

export interface ChatSendOptions {
  /**
   * Retry of a `sessionId: null` entry stays a one-shot even when the card
   * is context-capable (the recorded decision wins).
   */
  forceOneShot?: boolean;
}

export type ChatSend = (
  card: CapabilityCard,
  input: string,
  file: File | undefined,
  entries: ChatThreadEntry[],
  options?: ChatSendOptions,
) => Promise<void>;

/**
 * The Chat tab's send path (composer AND Retry): for a `context: true` card,
 * resolve the active session - adoption candidates are the identity-scoped
 * UUID-carrying entries of this thread - in ONE lock-held mutation that also
 * stamps the `inFlight` token, then hand both into `buy()` (which clears the
 * token on every exit that does not produce a pending entry). Context-off
 * cards send deliberate one-shots (`sessionId: null`).
 */
export function useChatSend({ agentPubkey, agentName, agentPicture }: Args): ChatSend {
  const { buy } = useBuy();
  const idCtx = useIdentity();
  const identityPubkey = idCtx.publicKey;

  return useCallback<ChatSend>(
    async (card, input, file, entries, options) => {
      const args = { agentPubkey, agentName, agentPicture, card };
      if (card.context === true && options?.forceOneShot !== true) {
        // Snapshot read of the candidates BEFORE the lock-held mutation (the
        // cross-family ordering invariant: a thread-store lock and a
        // chat-session lock are never held simultaneously).
        const candidates = sessionCandidatesOf(entries, identityPubkey);
        const resolved = await resolveSessionForSend(identityPubkey, agentPubkey, candidates);
        await buy(args, input, file, { sessionId: resolved.sessionId, token: resolved.token });
        return;
      }
      await buy(args, input, file, { sessionId: null });
    },
    [buy, identityPubkey, agentPubkey, agentName, agentPicture],
  );
}
