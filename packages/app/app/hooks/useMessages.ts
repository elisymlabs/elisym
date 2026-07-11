import type { ConversationSummary, DirectMessage } from '@elisym/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { readCursors, readCursorsVersion, subscribeReadCursors } from '~/lib/readCursors';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export function conversationsQueryKey(identityPubkey: string): string[] {
  return ['dm-conversations', identityPubkey];
}

export function threadQueryKey(identityPubkey: string, counterpartPubkey: string): string[] {
  return ['dm-thread', identityPubkey, counterpartPubkey];
}

/** Dedup by id, sort by (createdAt, id) - the SDK's deterministic order. */
export function mergeMessages(
  existing: DirectMessage[] | undefined,
  incoming: DirectMessage[],
): DirectMessage[] {
  const byId = new Map<string, DirectMessage>();
  for (const message of existing ?? []) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
}

/**
 * Conversation list for the active identity. `unreadCount` comes from the
 * SDK (single implementation shared with MCP), fed by the localStorage
 * read-cursor map; cursor moves re-trigger the query via the version store.
 */
export function useConversations() {
  const { client } = useElisymClient();
  const { identity, publicKey } = useIdentity();
  const cursorsVersion = useSyncExternalStore(subscribeReadCursors, readCursorsVersion);
  const queryClient = useQueryClient();

  const query = useLocalQuery<ConversationSummary[]>({
    queryKey: conversationsQueryKey(publicKey),
    queryFn: () =>
      client.messages.listConversations(identity, { readCursors: readCursors(publicKey) }),
    staleTime: 15_000,
  });

  // A cursor advance changes unread counts without changing the relay data;
  // refetch so the SDK recomputes them against the new map.
  useEffect(() => {
    if (cursorsVersion > 0) {
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKey(publicKey) });
    }
  }, [cursorsVersion, publicKey, queryClient]);

  return query;
}

/** Total unread across conversations - drives the header badge. */
export function useUnreadTotal(): number {
  const { data } = useConversations();
  if (!data) {
    return 0;
  }
  return data.reduce((sum, summary) => sum + (summary.unreadCount ?? 0), 0);
}

/** One conversation's messages, oldest first. */
export function useThread(counterpartPubkey: string) {
  const { client } = useElisymClient();
  const { identity, publicKey } = useIdentity();

  return useLocalQuery<DirectMessage[]>({
    queryKey: threadQueryKey(publicKey, counterpartPubkey),
    queryFn: () => client.messages.fetchHistory(identity, { withPubkey: counterpartPubkey }),
    enabled: HEX_PUBKEY_RE.test(counterpartPubkey),
    staleTime: 15_000,
  });
}

/**
 * App-wide live DM subscription. Mount exactly once (Header). Incoming
 * messages update the open thread's cache directly and invalidate the
 * conversation list; the subscription filter derives from the active
 * identity, so switching identities swaps the whole inbox.
 */
export function useLiveMessages(): void {
  const { client } = useElisymClient();
  const { identity, publicKey } = useIdentity();
  const queryClient = useQueryClient();

  useEffect(() => {
    const subscription = client.messages.subscribe(identity, (message) => {
      const counterpart = message.isMine ? message.recipientPubkey : message.senderPubkey;
      queryClient.setQueryData<DirectMessage[]>(
        threadQueryKey(publicKey, counterpart),
        (existing) => mergeMessages(existing, [message]),
      );
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKey(publicKey) });
    });
    return () => subscription.close();
  }, [client, identity, publicKey, queryClient]);
}
