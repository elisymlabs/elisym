import { formatSol, nip44Decrypt, toDTag, truncateKey } from '@elisym/sdk';
import { nip19, type Event as NostrEvent } from 'nostr-tools';
import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link, useParams } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
import { useAgentBanner } from '~/hooks/useAgentBanner';
import { useAgentDisplay } from '~/hooks/useAgentDisplay';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { usePingAgent, type PingStatus } from '~/hooks/usePingAgent';
import { useScrollEdges } from '~/hooks/useScrollEdges';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { cacheGet, cacheSet } from '~/lib/localCache';
import { VERIFIED_PUBKEYS } from '~/lib/verified';
import { AgentActivity } from './AgentActivity';
import { ArtifactCapturer } from './ArtifactCapturer';
import { ArtifactModal } from './ArtifactModal';
import { BuyProvider } from './BuyProvider';
import { FadeInImage } from './FadeInImage';
import { JobInput } from './JobInput';
import { cleanPreviewText, formatArtifactTime } from './lib/artifactPreview';
import { STATUS_DOT } from './lib/status';
import { ProductAvatar } from './ProductAvatar';
import { ProductCard } from './ProductCard';
import { ScrambleText } from './ScrambleText';
import type { Artifact } from './types';
import { useArtifacts } from './useArtifacts';
import { useNostrArtifacts } from './useNostrArtifacts';

const APPEAR_DURATION_MS = 600;
const THANKS_VISIBLE_MS = 3000;
const THANKS_MOUNT_MS = 3700;
const MAX_DISPLAY_NAME = 60;

const TABS = [
  {
    id: 'products' as const,
    label: 'Products',
    icon: (
      <svg
        aria-hidden
        className="size-14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z" />
      </svg>
    ),
  },
  {
    id: 'artifacts' as const,
    label: 'History',
    icon: (
      <svg
        aria-hidden
        className="size-14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
    ),
  },
  {
    id: 'activity' as const,
    label: 'Recent Activity',
    icon: (
      <svg
        aria-hidden
        className="size-14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 7 8 11 4 15" />
        <line x1="12" y1="15" x2="20" y2="15" />
      </svg>
    ),
  },
];

type TabId = (typeof TABS)[number]['id'];

function LoadingOverlay() {
  return createPortal(
    <div className="fixed inset-0 z-[9000] flex flex-col items-center justify-center gap-28 bg-bg-page">
      <img src="/logo.svg" alt="" className="logo-loader size-32" />
      <ScrambleText
        text="LOADING AGENT..."
        duration={1000}
        className="font-mono text-[11px] font-medium tracking-[0.08em] text-text-2"
      />
    </div>,
    document.body,
  );
}

function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="text-center">
        <h1 className="mb-8 text-xl font-bold">Agent not found</h1>
        <p className="mb-16 text-sm text-text-2">This agent may be offline or doesn't exist.</p>
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Back to marketplace
        </Link>
      </div>
    </div>
  );
}

function TabsBar({ activeTab, onSelect }: { activeTab: TabId; onSelect: (tab: TabId) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { atStart, atEnd } = useScrollEdges(scrollRef);
  return (
    <div className="relative -mx-4 mb-16 sm:mb-20">
      <div ref={scrollRef} className="no-scrollbar flex items-center gap-4 overflow-x-auto px-4">
        {TABS.map((tab, index) => {
          const active = activeTab === tab.id;
          const isFirst = index === 0;
          const isLast = index === TABS.length - 1;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={(event) => {
                onSelect(tab.id);
                const container = scrollRef.current;
                if (!container) {
                  return;
                }
                if (isFirst) {
                  container.scrollTo({ left: 0, behavior: 'smooth' });
                } else if (isLast) {
                  container.scrollTo({ left: container.scrollWidth, behavior: 'smooth' });
                } else {
                  event.currentTarget.scrollIntoView({
                    behavior: 'smooth',
                    inline: 'nearest',
                    block: 'nearest',
                  });
                }
              }}
              className={cn(
                'inline-flex shrink-0 cursor-pointer items-center gap-6 rounded-full border-0 px-12 py-8 text-[13px] font-medium whitespace-nowrap transition-colors sm:px-16 sm:py-10 sm:text-sm',
                active ? 'bg-tag-bg text-text' : 'bg-transparent text-text-2 hover:bg-tag-bg/60',
              )}
            >
              <span className="text-text-2">{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-surface to-transparent transition-opacity duration-150',
          atStart ? 'opacity-0' : 'opacity-100',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-surface to-transparent transition-opacity duration-150',
          atEnd ? 'opacity-0' : 'opacity-100',
        )}
      />
    </div>
  );
}

function mergeArtifacts(
  local: Artifact[],
  remote: Omit<Artifact, 'cardName'>[] | undefined,
  cards: { name: string }[],
): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of local) {
    byId.set(artifact.id, artifact);
  }
  if (remote) {
    const cardNameByDTag = new Map<string, string>();
    for (const card of cards) {
      cardNameByDTag.set(toDTag(card.name), card.name);
    }
    for (const partial of remote) {
      const existing = byId.get(partial.id);
      if (existing) {
        byId.set(partial.id, {
          ...existing,
          prompt: existing.prompt ?? partial.prompt,
          priceLamports: existing.priceLamports ?? partial.priceLamports,
        });
      } else {
        const capability = partial.capability;
        const cardName = (capability && cardNameByDTag.get(capability)) ?? capability ?? 'Job';
        byId.set(partial.id, { ...partial, cardName });
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function useHydrateArtifacts(
  artifacts: Artifact[],
  pubkey: string,
  updateArtifact: (id: string, patch: Partial<Artifact>) => void,
) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();

  useEffect(() => {
    const missing = artifacts.filter(
      (artifact) => !artifact.prompt || artifact.priceLamports === undefined,
    );
    if (missing.length === 0 || !pubkey) {
      return;
    }
    let cancelled = false;

    async function hydrate() {
      try {
        const ids = missing.map((artifact) => artifact.id);
        const identity = idCtx.identity;
        const [requests, resMap] = await Promise.all([
          client.pool.querySync({ ids }) as Promise<NostrEvent[]>,
          identity
            ? client.marketplace.queryJobResults(identity, ids).catch(() => new Map())
            : Promise.resolve(new Map()),
        ]);
        if (cancelled) {
          return;
        }
        for (const artifact of missing) {
          const req = requests.find((event) => event.id === artifact.id);
          const patch: Partial<Artifact> = {};
          if (req && !artifact.prompt) {
            const pTag = req.tags.find((tag) => tag[0] === 'p')?.[1];
            const isEncrypted = req.tags.some((tag) => tag[0] === 'encrypted');
            try {
              patch.prompt =
                isEncrypted && pTag && identity
                  ? nip44Decrypt(req.content, identity.secretKey, pTag)
                  : req.content;
            } catch {
              // decryption failed, skip
            }
          }
          const res = resMap.get(artifact.id);
          if (res && artifact.priceLamports === undefined) {
            patch.priceLamports = res.amount ?? 0;
          }
          if (Object.keys(patch).length > 0) {
            updateArtifact(artifact.id, patch);
          }
        }
      } catch {
        // silent fail
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [artifacts, client, idCtx.identity, pubkey, updateArtifact]);
}

export default function AgentPage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = params.pubkey ?? '';

  const { data: agents, isLoading } = useAgents();
  const { data: feedbackMap } = useAgentFeedback(pubkey ? [pubkey] : []);

  const agent = useMemo(
    () => (agents ?? []).find((candidate) => candidate.pubkey === pubkey),
    [agents, pubkey],
  );

  const displayAgents = useAgentDisplay(agent ? [agent] : [], feedbackMap);
  const agentData = agent ? displayAgents[0] : undefined;

  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === pubkey;
  const pingedStatus = usePingAgent(isOwn || !pubkey ? '' : pubkey);
  const pingStatus: PingStatus = isOwn ? 'online' : pingedStatus;

  const [selectedCardIndex, setSelectedCardIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>('products');
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [appeared, setAppeared] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAppeared(true), APPEAR_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);
  const appearCls = appeared ? '' : 'appear';

  const {
    artifacts,
    hydrated: artifactsHydrated,
    append: appendArtifact,
    update: updateArtifact,
  } = useArtifacts(pubkey);
  const { artifacts: nostrArtifacts, loading: nostrArtifactsLoading } = useNostrArtifacts(pubkey);
  const nostrBanner = useAgentBanner(pubkey);
  const { client } = useElisymClient();
  const [ratedArtifacts, setRatedArtifacts] = useState<Set<string>>(new Set());
  const [thanksVisible, setThanksVisible] = useState<Set<string>>(new Set());
  const [thanksMounted, setThanksMounted] = useState<Set<string>>(new Set());
  const [newArtifactIds, setNewArtifactIds] = useState<Set<string>>(new Set());
  const unseenStorageKey = `elisym:unseen-artifacts:${pubkey}`;
  const [unseenArtifactIds, setUnseenArtifactIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(unseenStorageKey);
      setUnseenArtifactIds(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setUnseenArtifactIds(new Set());
    }
  }, [unseenStorageKey]);
  const persistUnseen = useCallback(
    (ids: Set<string>) => {
      try {
        localStorage.setItem(unseenStorageKey, JSON.stringify([...ids]));
      } catch {
        // storage unavailable, ignore
      }
    },
    [unseenStorageKey],
  );

  useEffect(() => {
    if (artifacts.length === 0) {
      return;
    }
    let cancelled = false;
    Promise.all(
      artifacts.map(async (artifact) =>
        (await cacheGet<boolean>(`rated:${artifact.id}`)) ? artifact.id : null,
      ),
    ).then((ids) => {
      if (cancelled) {
        return;
      }
      const ratedSet = new Set(ids.filter((id): id is string => id !== null));
      if (ratedSet.size > 0) {
        setRatedArtifacts(ratedSet);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  useHydrateArtifacts(artifacts, pubkey, updateArtifact);

  const mergedArtifacts = useMemo(
    () => mergeArtifacts(artifacts, nostrArtifacts, agentData?.cards ?? []),
    [artifacts, nostrArtifacts, agentData],
  );

  const rateArtifact = useCallback(
    async (artifact: Artifact, positive: boolean) => {
      const identity = idCtx.identity;
      if (!artifact.capability || !identity || ratedArtifacts.has(artifact.id)) {
        return;
      }
      setRatedArtifacts((prev) => new Set(prev).add(artifact.id));
      setThanksMounted((prev) => new Set(prev).add(artifact.id));
      setThanksVisible((prev) => new Set(prev).add(artifact.id));
      setTimeout(() => {
        setThanksVisible((prev) => {
          const next = new Set(prev);
          next.delete(artifact.id);
          return next;
        });
      }, THANKS_VISIBLE_MS);
      setTimeout(() => {
        setThanksMounted((prev) => {
          const next = new Set(prev);
          next.delete(artifact.id);
          return next;
        });
      }, THANKS_MOUNT_MS);
      try {
        await client.marketplace.submitFeedback(
          identity,
          artifact.id,
          pubkey,
          positive,
          artifact.capability,
        );
        await cacheSet(`rated:${artifact.id}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // silent fail
      }
    },
    [client, idCtx.identity, pubkey, ratedArtifacts],
  );

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setSelectedCardIndex(0);
  }, [pubkey]);

  const displayName = agentData?.name || (pubkey ? truncateKey(nip19.npubEncode(pubkey), 8) : '');

  if (isLoading && !agentData) {
    return <LoadingOverlay />;
  }

  if (!agent || !agentData) {
    return <NotFound />;
  }

  const cards = agentData.cards;
  const feedbackPct =
    agentData.feedbackPositive > 0
      ? Math.round((agentData.feedbackPositive / agentData.feedbackTotal) * 100)
      : null;
  const clampedDisplayName =
    displayName.length > MAX_DISPLAY_NAME
      ? `${displayName.slice(0, MAX_DISPLAY_NAME)}…`
      : displayName;
  const currentCardIndex = Math.min(selectedCardIndex, cards.length - 1);
  const currentCard = cards[currentCardIndex];
  const openArtifact = openArtifactId
    ? mergedArtifacts.find((artifact) => artifact.id === openArtifactId)
    : undefined;

  function handleBackClick() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  }

  async function copyWallet() {
    if (!agentData?.walletAddress) {
      return;
    }
    await navigator.clipboard.writeText(agentData.walletAddress);
    toast.success('Wallet address copied');
  }

  function handleCloseArtifact(artifactId: string) {
    setOpenArtifactId(null);
    setNewArtifactIds((prev) => {
      if (!prev.has(artifactId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(artifactId);
      return next;
    });
    setUnseenArtifactIds((prev) => {
      if (!prev.has(artifactId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(artifactId);
      persistUnseen(next);
      return next;
    });
  }

  return (
    <div id="light-content" className="pt-12 pb-48 sm:pt-16 sm:pb-64">
      <div className="mx-auto max-w-5xl px-12 sm:px-24">
        {/* Profile Header Card */}
        <div
          className={cn(
            appearCls,
            'mb-12 overflow-hidden rounded-3xl border border-black/7 bg-surface shadow-[0_2px_24px_rgba(0,0,0,0.06)] [animation-delay:0ms] sm:mb-16',
          )}
        >
          {/* Banner */}
          <div className="relative h-96 w-full overflow-hidden sm:h-128">
            <button
              type="button"
              onClick={handleBackClick}
              className="absolute top-12 left-12 z-10 inline-flex cursor-pointer items-center gap-4 rounded-full bg-black/35 py-4 pr-12 pl-8 text-xs font-normal text-white/85 backdrop-blur-md transition-colors hover:bg-black/50 hover:text-white"
            >
              <svg
                aria-hidden
                className="size-12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 6 9 12 15 18" />
              </svg>
              Back
            </button>
            <div className="relative h-full w-full overflow-hidden bg-surface-dark">
              <div aria-hidden className="absolute inset-0 agent-banner-outer" />
              <div aria-hidden className="absolute inset-0 agent-banner-inner" />
              {nostrBanner && (
                <FadeInImage
                  src={nostrBanner}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </div>
          </div>

          {/* Avatar + info */}
          <div className="px-16 pb-16 sm:px-24 sm:pb-20">
            <div className="flex items-start justify-between gap-12">
              <div className="relative -mt-48 mb-10 size-80 shrink-0 sm:-mt-70 sm:mb-12 sm:size-100">
                <div className="size-80 overflow-hidden rounded-full border-2 border-white bg-surface-2 sm:size-100">
                  {agentData.picture ? (
                    <img
                      src={agentData.picture}
                      alt={displayName}
                      className="size-full object-cover"
                    />
                  ) : (
                    <MarbleAvatar name={pubkey} size={100} />
                  )}
                </div>
                <span
                  className={cn(
                    'absolute right-4 bottom-4 size-12 rounded-full border-2 border-white sm:right-8 sm:bottom-8 sm:size-14',
                    STATUS_DOT[pingStatus],
                  )}
                />
              </div>
              {agentData.lastPaidJobLabel && (
                <span
                  className="mt-12 shrink-0 text-xs text-text-2 opacity-60 sm:hidden"
                  title="Last paid job"
                >
                  {agentData.lastPaidJobLabel}
                </span>
              )}
            </div>

            <div className="flex flex-col items-start gap-8 sm:flex-row sm:items-start sm:justify-between sm:gap-12">
              <div className="min-w-0">
                <div className="mb-4 flex items-center gap-4">
                  <h1 className="text-lg leading-tight font-bold sm:text-xl">
                    {clampedDisplayName}
                  </h1>
                  {VERIFIED_PUBKEYS.has(pubkey) && <VerifiedBadge className="size-20" />}
                </div>

                {agentData.walletAddress && (
                  <button
                    type="button"
                    onClick={() => void copyWallet()}
                    className="group mb-10 inline-flex cursor-pointer items-center gap-6 border-0 bg-transparent p-0 font-mono text-xs text-text-2 opacity-60 transition-opacity hover:opacity-100 sm:mb-0"
                    title="Copy wallet address"
                  >
                    {truncateKey(agentData.walletAddress)}
                    <svg
                      aria-hidden
                      className="size-14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                )}
                <div className="flex flex-wrap items-center gap-x-12 gap-y-6 text-xs text-text-2 sm:mt-8 sm:gap-16">
                  {cards.length > 0 && (
                    <span className="flex items-center gap-6">
                      <svg
                        aria-hidden
                        className="size-14 shrink-0 opacity-50"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z" />
                      </svg>
                      {cards.length} {cards.length === 1 ? 'product' : 'products'}
                    </span>
                  )}
                  {agentData.purchases > 0 && (
                    <span className="flex items-center gap-6">
                      <svg
                        aria-hidden
                        className="size-14 shrink-0 opacity-50"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="8" cy="21" r="1" />
                        <circle cx="19" cy="21" r="1" />
                        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
                      </svg>
                      {agentData.purchases} {agentData.purchases === 1 ? 'order' : 'orders'}
                    </span>
                  )}
                  {feedbackPct !== null && (
                    <span className="flex items-center gap-6">
                      <svg
                        aria-hidden
                        className="size-14 shrink-0 text-green"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                      {feedbackPct}% positive
                    </span>
                  )}
                </div>
              </div>

              {agentData.lastPaidJobLabel && (
                <div
                  className="hidden shrink-0 text-xs text-text-2 opacity-60 sm:block sm:text-right"
                  title="Last paid job"
                >
                  {agentData.lastPaidJobLabel}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 2-column layout */}
        <div className="agent-page-grid items-start">
          {/* Left column */}
          <BuyProvider
            card={currentCard}
            agentPubkey={pubkey}
            agentName={agentData.name}
            agentPicture={agentData.picture}
          >
            {(buyState) => (
              <div className="order-2 flex min-w-0 flex-col gap-16 lg:order-1">
                {/* Tabs + content */}
                <div
                  className={cn(
                    appearCls,
                    'rounded-3xl border border-black/7 bg-surface p-14 shadow-[0_1px_8px_rgba(0,0,0,0.05)] [animation-delay:80ms] sm:p-20',
                  )}
                >
                  <TabsBar activeTab={activeTab} onSelect={setActiveTab} />

                  {activeTab === 'products' && (
                    <ProductsTab
                      cards={cards}
                      selectedCardIndex={selectedCardIndex}
                      onSelect={setSelectedCardIndex}
                    />
                  )}

                  {activeTab === 'artifacts' && (
                    <ArtifactsTab
                      artifacts={mergedArtifacts}
                      loading={
                        !artifactsHydrated || (artifacts.length === 0 && nostrArtifactsLoading)
                      }
                      newArtifactIds={newArtifactIds}
                      unseenArtifactIds={unseenArtifactIds}
                      onOpenArtifact={setOpenArtifactId}
                      onAnimationEnd={(artifactId) =>
                        setNewArtifactIds((prev) => {
                          if (!prev.has(artifactId)) {
                            return prev;
                          }
                          const next = new Set(prev);
                          next.delete(artifactId);
                          return next;
                        })
                      }
                    />
                  )}

                  {activeTab === 'activity' && (
                    <AgentActivity agentPubkey={pubkey} productCount={cards.length} />
                  )}
                </div>

                {cards.length > 0 && activeTab === 'products' && (
                  <>
                    <div
                      className={cn(
                        appearCls,
                        'relative sticky bottom-0 z-40 -mx-12 [animation-delay:160ms] lg:static lg:mx-0',
                      )}
                    >
                      <div
                        aria-hidden
                        className="pointer-events-none absolute -top-20 right-0 left-0 h-20 bg-gradient-to-t from-bg-page to-transparent lg:hidden"
                      />
                      <div className="bg-bg-page px-12 pb-[max(env(safe-area-inset-bottom),10px)] lg:bg-transparent lg:p-0">
                        <JobInput
                          agentPubkey={pubkey}
                          agentName={agentData.name}
                          pingStatus={pingStatus}
                          cards={cards}
                          selectedIndex={currentCardIndex}
                          onSelectIndex={setSelectedCardIndex}
                          buyState={buyState}
                        />
                      </div>
                    </div>
                    <p className="-mt-8 px-16 text-center text-[11px] text-text-2/50">
                      Agents on Elisym can make mistakes. Always verify important information.
                    </p>
                  </>
                )}

                <ArtifactCapturer
                  buyState={buyState}
                  card={currentCard}
                  onCapture={(artifact) => {
                    appendArtifact(artifact);
                    setActiveTab('artifacts');
                    setNewArtifactIds((prev) => {
                      const next = new Set(prev);
                      next.add(artifact.id);
                      return next;
                    });
                    setUnseenArtifactIds((prev) => {
                      const next = new Set(prev);
                      next.add(artifact.id);
                      persistUnseen(next);
                      return next;
                    });
                  }}
                />
              </div>
            )}
          </BuyProvider>

          {/* Right column */}
          <div className="order-1 flex min-w-0 flex-col gap-16 lg:sticky lg:top-16 lg:order-2">
            {(agentData.description || agentData.tags.length > 0) && (
              <div
                className={cn(
                  appearCls,
                  'rounded-3xl border border-black/7 bg-surface p-14 shadow-[0_1px_8px_rgba(0,0,0,0.05)] [animation-delay:120ms] sm:p-20',
                )}
              >
                <h2 className="mb-12 text-base font-semibold sm:mb-16">About</h2>
                {agentData.description && (
                  <p className="m-0 text-sm leading-relaxed text-text-2">{agentData.description}</p>
                )}
                {agentData.tags.length > 0 && (
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-6',
                      agentData.description && 'mt-16',
                    )}
                  >
                    {agentData.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-tag-bg px-10 py-4 font-mono text-[11px] font-medium tracking-wide text-text-2 uppercase"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {openArtifact && (
        <ArtifactModal
          artifact={openArtifact}
          onClose={() => handleCloseArtifact(openArtifact.id)}
          isRated={ratedArtifacts.has(openArtifact.id)}
          thanksMounted={thanksMounted.has(openArtifact.id)}
          thanksVisible={thanksVisible.has(openArtifact.id)}
          onRate={(positive) => void rateArtifact(openArtifact, positive)}
        />
      )}
    </div>
  );
}

function ProductsTab({
  cards,
  selectedCardIndex,
  onSelect,
}: {
  cards: ReturnType<typeof useAgentDisplay>[number]['cards'];
  selectedCardIndex: number;
  onSelect: (index: number) => void;
}) {
  if (cards.length === 0) {
    return <p className="py-24 text-center text-sm text-text-2">No products yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
      {cards.map((card, index) => (
        <ProductCard
          key={card.name}
          card={card}
          selected={selectedCardIndex === index}
          onClick={() => onSelect(index)}
        />
      ))}
    </div>
  );
}

interface ArtifactsTabProps {
  artifacts: Artifact[];
  loading: boolean;
  newArtifactIds: Set<string>;
  unseenArtifactIds: Set<string>;
  onOpenArtifact: (id: string) => void;
  onAnimationEnd: (id: string) => void;
}

function ArtifactsTab({
  artifacts,
  loading,
  newArtifactIds,
  unseenArtifactIds,
  onOpenArtifact,
  onAnimationEnd,
}: ArtifactsTabProps) {
  if (loading) {
    return <ArtifactsTabSkeleton />;
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-16 py-56">
        <p className="m-0 text-sm text-text-2">No history yet</p>
        <p className="m-0 mt-4 text-center text-sm text-text-2/60">
          Results from your jobs will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
      {artifacts.map((artifact) => (
        <ArtifactTile
          key={artifact.id}
          artifact={artifact}
          isNew={newArtifactIds.has(artifact.id)}
          isUnseen={unseenArtifactIds.has(artifact.id)}
          onClick={() => onOpenArtifact(artifact.id)}
          onAnimationEnd={() => onAnimationEnd(artifact.id)}
        />
      ))}
    </div>
  );
}

const ARTIFACT_SKELETON_COUNT = 4;

function ArtifactsTabSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
      {Array.from({ length: ARTIFACT_SKELETON_COUNT }).map((_, index) => (
        <ArtifactTileSkeleton key={index} />
      ))}
    </div>
  );
}

function ArtifactTileSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-black/7 bg-surface p-16 shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] sm:p-24">
      <div className="mb-12 flex items-center gap-12">
        <div className="skeleton size-28 rounded-full" />
        <div className="skeleton h-12 w-96 rounded-full" />
      </div>
      <div className="flex flex-1 flex-col gap-12">
        <div className="flex flex-col gap-6">
          <div className="skeleton h-10 w-48 rounded-full" />
          <div className="skeleton h-12 w-full rounded-full" />
          <div className="skeleton h-12 w-4/5 rounded-full" />
        </div>
        <div className="flex flex-col gap-6">
          <div className="skeleton h-10 w-48 rounded-full" />
          <div className="skeleton h-12 w-full rounded-full" />
          <div className="skeleton h-12 w-3/4 rounded-full" />
        </div>
      </div>
      <div className="mt-16 flex items-center gap-8 border-t border-black/6 pt-12">
        <div className="skeleton h-10 w-64 rounded-full" />
        <div className="skeleton ml-auto h-10 w-48 rounded-full" />
      </div>
    </div>
  );
}

interface ArtifactTileProps {
  artifact: Artifact;
  isNew: boolean;
  isUnseen: boolean;
  onClick: () => void;
  onAnimationEnd: () => void;
}

function ArtifactTile({ artifact, isNew, isUnseen, onClick, onAnimationEnd }: ArtifactTileProps) {
  const preview = cleanPreviewText(artifact.result);
  const hasPrice = artifact.priceLamports !== undefined && artifact.priceLamports > 0;
  const knownPrice = artifact.priceLamports !== undefined;

  let priceNode: ReactNode = null;
  if (knownPrice && artifact.priceLamports !== undefined) {
    priceNode = (
      <span className="ml-auto font-semibold">
        {hasPrice ? formatSol(artifact.priceLamports) : 'Free'}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-3xl border border-black/7 bg-surface p-16 text-left shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-all hover:-translate-y-2 hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] sm:p-24"
    >
      {isNew && (
        <span
          aria-hidden
          onAnimationEnd={onAnimationEnd}
          className="pointer-events-none absolute top-0 bottom-0 w-[60%] [animation:artifact-shimmer-sweep_1.4s_ease-out_0.15s_both] [background:linear-gradient(100deg,transparent_20%,rgba(255,255,255,0.65)_50%,transparent_80%)]"
        />
      )}
      <div className="mb-12 flex min-w-0 items-center gap-12">
        <ProductAvatar name={artifact.cardName} size={28} />
        <div className="truncate text-xs font-medium text-text-2">{artifact.cardName}</div>
        {isUnseen && (
          <span className="shrink-0 rounded-full border border-stat-emerald/20 bg-stat-emerald-bg px-10 py-2 font-mono text-[10px] font-medium tracking-wide text-stat-emerald uppercase">
            New
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-12">
        {artifact.prompt && (
          <div className="w-full rounded-xl py-8 pr-12 pl-12 prompt-block">
            <div className="mb-2 text-xs text-text-2">Prompt</div>
            <div className="line-clamp-2 text-[13px] leading-relaxed break-words text-text">
              {artifact.prompt}
            </div>
          </div>
        )}
        {preview && (
          <div>
            <div className="mb-2 text-xs text-text-2">Answer</div>
            <div className="line-clamp-2 text-[13px] leading-relaxed break-words text-text">
              {preview}
            </div>
          </div>
        )}
      </div>
      <div className="mt-16 flex items-center gap-8 border-t border-black/6 pt-12 text-[11px] text-text-2/70">
        <span>{formatArtifactTime(artifact.createdAt)}</span>
        {priceNode}
      </div>
    </button>
  );
}
