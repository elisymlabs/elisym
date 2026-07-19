import { type CapabilityCard, toDTag } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBuy } from '~/contexts/BuyContext';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import type { PingStatus } from '~/hooks/usePingAgent';
import { track } from '~/lib/analytics';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import { cacheGet, cacheSet } from '~/lib/localCache';
import { ArtifactModal } from './ArtifactModal';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import type { Artifact, BuyState } from './types';
import { useChatReconcile } from './useChatReconcile';
import { useChatSend } from './useChatSend';

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

/**
 * The Chat tab: job transcript as a thread + a composer bound to the selected
 * capability card. Mounting it runs the tab-open reconcile (wallet-independent
 * pending recovery + unpaid aging).
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
        // silent fail
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
    (entry: ChatThreadEntry) => cardNameByDTag.get(entry.capability) ?? (entry.capability || 'Job'),
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

  return (
    <div className="flex flex-col">
      <ChatThread
        entries={entries}
        agentPubkey={agentPubkey}
        loading={loading}
        cards={cards}
        pingStatus={pingStatus}
        buying={buyState?.buying ?? false}
        liveJobEventId={liveJobEventId}
        liveStatus={liveStatus}
        ratedIds={ratedIds}
        canRate={Boolean(idCtx.identity)}
        onRate={(entry, positive) => void rateEntry(entry, positive)}
        onOpen={(entry) => setOpenEntryId(entry.jobEventId)}
        onSelectCardIndex={onSelectIndex}
        send={send}
      />

      {card && buyState && (
        <ChatComposer
          card={card}
          allCards={cards}
          selectedIndex={selectedIndex}
          onSelectIndex={onSelectIndex}
          agentPubkey={agentPubkey}
          agentName={agentName}
          identityPubkey={idCtx.publicKey}
          pingStatus={pingStatus}
          buyState={buyState}
          entries={entries}
          send={send}
        />
      )}

      {openEntry && (
        <ArtifactModal
          artifact={entryToArtifact(openEntry, agentPubkey, cardNameOf(openEntry))}
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
