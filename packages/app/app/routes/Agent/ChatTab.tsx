import { type CapabilityCard, toDTag } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBuy } from '~/contexts/BuyContext';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import type { PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import {
  chatSessionsVersion,
  readChatSession,
  rotateSession,
  selectSession,
  subscribeChatSessions,
} from '~/lib/chatSession';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import { cacheGet, cacheSet } from '~/lib/localCache';
import { ArtifactModal } from './ArtifactModal';
import { ChatComposer } from './ChatComposer';
import { ChatList } from './ChatList';
import { ChatThread } from './ChatThread';
import { buildChatList, chatKeyOf, NEW_CHAT_KEY, type ChatListItem } from './lib/chatList';
import type { Artifact, BuyState } from './types';
import { useChatReconcile } from './useChatReconcile';
import { useChatSend, type ChatSend } from './useChatSend';

interface Props {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  pingStatus: PingStatus;
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  buyState: BuyState | null;
  /** Identity-scoped, ts-sorted thread entries (page-owned snapshot). */
  entries: ChatThreadEntry[];
  loading: boolean;
}

const THANKS_VISIBLE_MS = 3000;
const THANKS_MOUNT_MS = 3700;

/** Adapt a thread entry to the modal's Artifact shape (full-result view). */
function entryToArtifact(entry: ChatThreadEntry, agentPubkey: string, cardName: string): Artifact {
  return {
    id: entry.jobEventId,
    cardName,
    result: entry.result ?? '',
    createdAt: entry.ts,
    ...(entry.priceLamports !== undefined ? { priceLamports: entry.priceLamports } : {}),
    ...(entry.asset !== undefined ? { asset: entry.asset } : {}),
    ...(entry.prompt ? { prompt: entry.prompt } : {}),
    ...(entry.promptAttachment !== undefined
      ? { promptAttachment: entry.promptAttachment, promptProviderPubkey: agentPubkey }
      : {}),
    ...(entry.capability ? { capability: entry.capability } : {}),
    ...(entry.resultAttachments !== undefined
      ? { resultAttachments: entry.resultAttachments, resultProviderPubkey: agentPubkey }
      : {}),
  };
}

interface ClosedChatNoteProps {
  onNewChat: () => void;
  disabled: boolean;
}

/** Footer for a selected one-off chat: closed by design, no composer. */
function ClosedChatNote({ onNewChat, disabled }: ClosedChatNoteProps) {
  return (
    <div className="mt-12 flex items-center justify-between gap-8 rounded-12 bg-surface-2/70 px-12 py-8 text-xs text-text-2">
      <span>This was a one-off job - each message is independent, so this chat is closed.</span>
      <button
        type="button"
        onClick={onNewChat}
        disabled={disabled}
        className="shrink-0 cursor-pointer rounded-full border border-black/10 bg-surface px-10 py-4 text-[11px] font-medium text-text transition-colors hover:bg-black/4 disabled:cursor-not-allowed disabled:opacity-40"
      >
        New chat
      </button>
    </div>
  );
}

/**
 * The Chat tab: a Terms-style sidebar of chats (one per conversation session,
 * one per one-off job) + the selected chat's thread. Conversation chats stay
 * writable through the composer; one-off chats are closed - a new message
 * always goes to a new chat. Mounting runs the tab-open reconcile
 * (wallet-independent pending recovery + unpaid aging).
 */
export function ChatTab({
  agentPubkey,
  agentName,
  agentPicture,
  pingStatus,
  cards,
  selectedIndex,
  onSelectIndex,
  buyState,
  entries,
  loading,
}: Props) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const identityPubkey = idCtx.publicKey;
  const { session: liveSession } = useBuy();
  const send = useChatSend({ agentPubkey, agentName, agentPicture });

  useChatReconcile(agentPubkey);

  // The connected Solana wallet's job history holds the payment tx per job, so
  // a rating can carry the payment proof for the future indexer (the entry's
  // own txHash is NOT used - a reverted tx must never ride a rating as proof).
  const { publicKey: walletPublicKey } = useWallet();
  const { jobs: walletJobs } = useJobHistory({ wallet: walletPublicKey?.toBase58() ?? '' });
  const txHashByJobId = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of walletJobs) {
      if (job.txHash) {
        map.set(job.jobEventId, job.txHash);
      }
    }
    return map;
  }, [walletJobs]);

  // Rated-state single source of truth: the `rated:<jobId>` kv flags (they
  // survive the logout purge by design; the thread entries do not).
  const [ratedIds, setRatedIds] = useState<Set<string>>(new Set());
  const [thanksVisible, setThanksVisible] = useState<Set<string>>(new Set());
  const [thanksMounted, setThanksMounted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (entries.length === 0) {
      return;
    }
    let cancelled = false;
    Promise.all(
      entries.map(async (entry) =>
        (await cacheGet<boolean>(`rated:${entry.jobEventId}`)) ? entry.jobEventId : null,
      ),
    ).then((ids) => {
      if (cancelled) {
        return;
      }
      const rated = new Set(ids.filter((id): id is string => id !== null));
      if (rated.size > 0) {
        setRatedIds((prev) => new Set([...prev, ...rated]));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const rateEntry = useCallback(
    async (entry: ChatThreadEntry, positive: boolean) => {
      const identity = idCtx.identity;
      if (!entry.capability || !identity || ratedIds.has(entry.jobEventId)) {
        return;
      }
      setRatedIds((prev) => new Set(prev).add(entry.jobEventId));
      setThanksMounted((prev) => new Set(prev).add(entry.jobEventId));
      setThanksVisible((prev) => new Set(prev).add(entry.jobEventId));
      setTimeout(() => {
        setThanksVisible((prev) => {
          const next = new Set(prev);
          next.delete(entry.jobEventId);
          return next;
        });
      }, THANKS_VISIBLE_MS);
      setTimeout(() => {
        setThanksMounted((prev) => {
          const next = new Set(prev);
          next.delete(entry.jobEventId);
          return next;
        });
      }, THANKS_MOUNT_MS);
      try {
        await client.marketplace.submitFeedback(
          identity,
          entry.jobEventId,
          agentPubkey,
          positive,
          entry.capability,
          { txSignature: txHashByJobId.get(entry.jobEventId), network: SOLANA_CLUSTER },
        );
        await cacheSet(`rated:${entry.jobEventId}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // The rating never reached the network (publish throws only on total
        // failure) - roll back the optimistic state so the buttons come back
        // and the user can retry, instead of a "Rated" that a reload undoes.
        setRatedIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.jobEventId);
          return next;
        });
        setThanksVisible((prev) => {
          const next = new Set(prev);
          next.delete(entry.jobEventId);
          return next;
        });
        setThanksMounted((prev) => {
          const next = new Set(prev);
          next.delete(entry.jobEventId);
          return next;
        });
      }
    },
    [client, idCtx.identity, agentPubkey, ratedIds, txHashByJobId],
  );

  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const openEntry = openEntryId
    ? entries.find((entry) => entry.jobEventId === openEntryId)
    : undefined;

  const cardNameByDTag = useMemo(() => {
    const map = new Map<string, string>();
    for (const card of cards) {
      map.set(toDTag(card.name), card.name);
    }
    return map;
  }, [cards]);

  const cardNameOf = useCallback(
    (capability: string) => cardNameByDTag.get(capability) ?? (capability || 'Job'),
    [cardNameByDTag],
  );

  // The in-flight entry's live status line, from the global ActiveBuySession.
  const liveJobEventId = liveSession?.buying || liveSession?.pending ? liveSession.jobId : null;
  let liveStatus: string | null = null;
  if (liveSession?.phase === 'paying') {
    liveStatus = 'Paying…';
  } else if (liveSession?.phase === 'processing' || liveSession?.pending) {
    liveStatus = 'Processing…';
  } else if (liveSession?.phase === 'awaiting-provider') {
    liveStatus = 'Waiting for the provider…';
  }

  const card = cards[selectedIndex] ?? cards[0];
  const buying = buyState?.buying ?? false;

  // -- Chat list + selection --
  const items = useMemo(() => buildChatList(entries), [entries]);

  const sessionsVersion = useSyncExternalStore(subscribeChatSessions, chatSessionsVersion);
  const currentSession = useMemo(
    () => readChatSession(identityPubkey, agentPubkey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsVersion re-reads the persisted entry
    [identityPubkey, agentPubkey, sessionsVersion],
  );

  const [manualKey, setManualKey] = useState<string | null>(null);

  // Resolved selection: the manual choice while its chat still exists, else
  // the active session's chat, else the newest chat, else the draft.
  let selectedKey = NEW_CHAT_KEY;
  const manualValid =
    manualKey !== null &&
    (manualKey === NEW_CHAT_KEY || items.some((item) => item.key === manualKey));
  const activeSessionItem =
    currentSession !== undefined
      ? items.find((item) => item.sessionId === currentSession.sessionId)
      : undefined;
  if (manualValid && manualKey !== null) {
    selectedKey = manualKey;
  } else if (activeSessionItem !== undefined) {
    selectedKey = activeSessionItem.key;
  } else if (items[0] !== undefined) {
    selectedKey = items[0].key;
  }

  // Follow the active session when it changes (send-mint, draft rotation, a
  // divergence join, a selection in another surface) - the composer writes
  // there, so the view must too.
  const prevSessionIdRef = useRef<string | undefined>(currentSession?.sessionId);
  useEffect(() => {
    const sessionId = currentSession?.sessionId;
    if (sessionId === prevSessionIdRef.current) {
      return;
    }
    prevSessionIdRef.current = sessionId;
    if (sessionId === undefined) {
      return;
    }
    const item = items.find((candidate) => candidate.sessionId === sessionId);
    setManualKey(item !== undefined ? item.key : NEW_CHAT_KEY);
  }, [currentSession?.sessionId, items]);

  // Follow a live send once per job id (the messenger pattern: jump to the
  // chat you just messaged) - covers draft sends, retries, and one-shots.
  const followedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (liveJobEventId === null || followedJobRef.current === liveJobEventId) {
      return;
    }
    const entry = entries.find((candidate) => candidate.jobEventId === liveJobEventId);
    if (entry !== undefined) {
      followedJobRef.current = liveJobEventId;
      setManualKey(chatKeyOf(entry));
    }
  }, [liveJobEventId, entries]);

  function handleSelectChat(item: ChatListItem) {
    if (buying) {
      return;
    }
    setManualKey(item.key);
    if (item.kind === 'session' && item.sessionId !== undefined) {
      // Make the clicked conversation the active session so the composer's
      // next send continues it, and bind the composer to the chat's last
      // used capability.
      void selectSession(identityPubkey, agentPubkey, {
        sessionId: item.sessionId,
        ts: item.lastTs,
      });
      const lastEntry = item.entries[item.entries.length - 1];
      const cardIndex = cards.findIndex(
        (candidate) => toDTag(candidate.name) === lastEntry?.capability,
      );
      if (cardIndex !== -1) {
        onSelectIndex(cardIndex);
      }
    }
  }

  function handleNewChat() {
    if (buying) {
      return;
    }
    setManualKey(NEW_CHAT_KEY);
  }

  // A draft send must open a NEW conversation: rotate away an active session
  // that already has visible entries. An empty active session IS the draft
  // and is continued as-is; one-shot sends need no rotation at all.
  const activeSessionHasEntries = activeSessionItem !== undefined;
  const sendFromDraft = useCallback<ChatSend>(
    async (draftCard, input, file, sendEntries, options) => {
      if (draftCard.context === true && activeSessionHasEntries) {
        await rotateSession(identityPubkey, agentPubkey);
      }
      await send(draftCard, input, file, sendEntries, options);
    },
    [send, identityPubkey, agentPubkey, activeSessionHasEntries],
  );

  const selectedItem =
    selectedKey === NEW_CHAT_KEY ? undefined : items.find((item) => item.key === selectedKey);
  const chatEntries = selectedItem?.entries ?? [];
  const readOnly = selectedItem?.kind === 'oneshot';

  return (
    <div className="grid gap-16 sm:grid-cols-[240px_1fr] sm:gap-32">
      <ChatList
        items={items}
        selectedKey={selectedKey}
        onSelect={handleSelectChat}
        onNewChat={handleNewChat}
        disabled={buying}
        cardNameOf={cardNameOf}
      />

      <div className="flex min-w-0 flex-col">
        <ChatThread
          entries={chatEntries}
          allEntries={entries}
          hasChats={items.length > 0}
          agentPubkey={agentPubkey}
          loading={loading}
          cards={cards}
          pingStatus={pingStatus}
          buying={buying}
          liveJobEventId={liveJobEventId}
          liveStatus={liveStatus}
          ratedIds={ratedIds}
          canRate={Boolean(idCtx.identity)}
          onRate={(entry, positive) => void rateEntry(entry, positive)}
          onOpen={(entry) => setOpenEntryId(entry.jobEventId)}
          onSelectCardIndex={onSelectIndex}
          send={send}
        />

        {readOnly ? (
          <ClosedChatNote onNewChat={handleNewChat} disabled={buying} />
        ) : (
          card &&
          buyState && (
            <ChatComposer
              card={card}
              allCards={cards}
              selectedIndex={selectedIndex}
              onSelectIndex={onSelectIndex}
              agentPubkey={agentPubkey}
              agentName={agentName}
              identityPubkey={identityPubkey}
              pingStatus={pingStatus}
              buyState={buyState}
              entries={entries}
              send={selectedKey === NEW_CHAT_KEY ? sendFromDraft : send}
            />
          )
        )}
      </div>

      {openEntry && (
        <ArtifactModal
          artifact={entryToArtifact(openEntry, agentPubkey, cardNameOf(openEntry.capability))}
          onClose={() => setOpenEntryId(null)}
          isRated={ratedIds.has(openEntry.jobEventId)}
          thanksMounted={thanksMounted.has(openEntry.jobEventId)}
          thanksVisible={thanksVisible.has(openEntry.jobEventId)}
          onRate={(positive) => void rateEntry(openEntry, positive)}
        />
      )}
    </div>
  );
}
