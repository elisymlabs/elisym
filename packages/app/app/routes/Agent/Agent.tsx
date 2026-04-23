import { formatSol, nip44Decrypt, truncateKey } from '@elisym/sdk';
import { nip19, type Event as NostrEvent } from 'nostr-tools';
import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react';
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

  const { artifacts, append: appendArtifact, update: updateArtifact } = useArtifacts(pubkey);
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
    ? artifacts.find((artifact) => artifact.id === openArtifactId)
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
    <div id="light-content" className="pt-16 pb-64">
      <div className="mx-auto max-w-5xl px-16 sm:px-24">
        {/* Profile Header Card */}
        <div
          className={cn(
            appearCls,
            'mb-16 overflow-hidden rounded-3xl border border-black/7 bg-surface shadow-[0_2px_24px_rgba(0,0,0,0.06)] [animation-delay:0ms]',
          )}
        >
          {/* Banner */}
          <div className="relative h-128 w-full overflow-hidden">
            <button
              type="button"
              onClick={handleBackClick}
              className="absolute top-12 left-12 z-10 inline-flex cursor-pointer items-center gap-4 rounded-full border border-white/10 bg-black/35 py-4 pr-12 pl-8 text-xs font-normal text-white/85 backdrop-blur-md transition-colors hover:bg-black/50 hover:text-white"
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
          <div className="px-24 pb-20">
            <div className="relative -mt-70 mb-12 size-100 shrink-0">
              <div className="size-100 overflow-hidden rounded-full border-4 border-white bg-surface-2">
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
                  'absolute right-8 bottom-8 size-14 rounded-full border-2 border-white',
                  STATUS_DOT[pingStatus],
                )}
              />
            </div>

            <div className="flex items-start justify-between gap-12">
              <div className="min-w-0">
                <div className="mb-8 flex items-center gap-4">
                  <h1 className="text-xl leading-tight font-bold">{clampedDisplayName}</h1>
                  {VERIFIED_PUBKEYS.has(pubkey) && <VerifiedBadge className="size-20" />}
                </div>

                <div className="flex flex-wrap items-center gap-16 text-xs text-text-2">
                  {agentData.walletAddress && (
                    <button
                      type="button"
                      onClick={() => void copyWallet()}
                      className="group inline-flex cursor-pointer items-center gap-6 border-0 bg-transparent p-0 font-mono opacity-60 transition-opacity hover:opacity-100"
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
                  {agentData.walletAddress &&
                    (cards.length > 0 || agentData.purchases > 0 || feedbackPct !== null) && (
                      <span aria-hidden className="h-14 w-px bg-border" />
                    )}
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

              <div className="shrink-0 text-right text-xs text-text-2 opacity-60">
                {agentData.lastSeen}
              </div>
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
              <div className="flex min-w-0 flex-col gap-16">
                {/* Tabs + content */}
                <div
                  className={cn(
                    appearCls,
                    'rounded-3xl border border-black/7 bg-surface p-20 shadow-[0_1px_8px_rgba(0,0,0,0.05)] [animation-delay:80ms]',
                  )}
                >
                  <div className="-mx-4 mb-20 flex items-center gap-4">
                    {TABS.map((tab) => {
                      const active = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActiveTab(tab.id)}
                          className={cn(
                            'inline-flex cursor-pointer items-center gap-6 rounded-full border-0 px-16 py-10 text-sm font-medium transition-colors',
                            active
                              ? 'bg-tag-bg text-text'
                              : 'bg-transparent text-text-2 hover:bg-tag-bg/60',
                          )}
                        >
                          <span className="text-text-2">{tab.icon}</span>
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>

                  {activeTab === 'products' && (
                    <ProductsTab
                      cards={cards}
                      selectedCardIndex={selectedCardIndex}
                      onSelect={setSelectedCardIndex}
                    />
                  )}

                  {activeTab === 'artifacts' && (
                    <ArtifactsTab
                      artifacts={artifacts}
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
                  <div className={cn(appearCls, '[animation-delay:160ms]')}>
                    <JobInput
                      agentPubkey={pubkey}
                      agentName={agentData.name}
                      pingStatus={pingStatus}
                      cards={cards}
                      selectedIndex={currentCardIndex}
                      onSelectIndex={setSelectedCardIndex}
                      buyState={buyState}
                    />
                    <p className="mt-8 px-16 text-center text-[11px] text-text-2/50">
                      Agents on Elisym can make mistakes. Always verify important information.
                    </p>
                  </div>
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
          <div className="flex min-w-0 flex-col gap-16 lg:sticky lg:top-16">
            {(agentData.description || agentData.tags.length > 0) && (
              <div
                className={cn(
                  appearCls,
                  'rounded-3xl border border-black/7 bg-surface p-20 shadow-[0_1px_8px_rgba(0,0,0,0.05)] [animation-delay:120ms]',
                )}
              >
                <h2 className="mb-16 text-base font-semibold">About</h2>
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
                        className="rounded-full bg-tag-bg px-10 py-4 text-[11px] font-semibold tracking-wide text-text-2 uppercase"
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
  newArtifactIds: Set<string>;
  unseenArtifactIds: Set<string>;
  onOpenArtifact: (id: string) => void;
  onAnimationEnd: (id: string) => void;
}

function ArtifactsTab({
  artifacts,
  newArtifactIds,
  unseenArtifactIds,
  onOpenArtifact,
  onAnimationEnd,
}: ArtifactsTabProps) {
  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-16 py-56">
        <p className="m-0 text-sm text-text-2">No history yet</p>
        <p className="m-0 mt-4 text-sm text-text-2/60">Results from your jobs will appear here</p>
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
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-3xl border border-black/7 bg-surface p-24 text-left shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-all hover:-translate-y-2 hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)]"
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
          <span className="inline-flex shrink-0 items-center rounded-full px-10 py-[3px] text-[11px] font-semibold artifact-new-badge">
            New
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-12">
        {artifact.prompt && (
          <div className="w-full rounded-xl py-8 pr-12 pl-12 prompt-block">
            <div className="mb-6 text-xs text-text-2">Prompt</div>
            <div className="line-clamp-2 text-[13px] leading-relaxed break-words text-text">
              {artifact.prompt}
            </div>
          </div>
        )}
        {preview && (
          <div>
            <div className="mb-6 text-xs text-text-2">Answer</div>
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
