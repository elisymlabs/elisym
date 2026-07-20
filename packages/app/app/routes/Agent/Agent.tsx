import { truncateKey } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { nip19 } from 'nostr-tools';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
import { useBuyForCard } from '~/contexts/BuyContext';
import { useAgent } from '~/hooks/useAgent';
import { useAgentDisplay } from '~/hooks/useAgentDisplay';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useIdentity } from '~/hooks/useIdentity';
import { usePingAgent, type PingStatus } from '~/hooks/usePingAgent';
import { useScrollEdges } from '~/hooks/useScrollEdges';
import { cn } from '~/lib/cn';
import { VERIFIED_PUBKEYS } from '~/lib/verified';
import { AgentActivity } from './AgentActivity';
import { ChatTab } from './ChatTab';
import { FadeInImage } from './FadeInImage';
import { JobInput } from './JobInput';
import { STATUS_DOT } from './lib/status';
import { PoliciesPanel } from './PoliciesPanel';
import { ProductCard } from './ProductCard';
import { ScrambleText } from './ScrambleText';
import { useChatHydration } from './useChatHydration';
import { identityThreadEntries, useChatThread } from './useChatThread';

const APPEAR_DURATION_MS = 600;
const MAX_DISPLAY_NAME = 60;

// A Nostr pubkey is a 32-byte ed25519 key rendered as 64 lowercase hex chars.
// The route param is user-controlled, so a malformed value would otherwise
// reach `nip19.npubEncode` and throw, crashing render. Route those to NotFound.
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

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
    id: 'chat' as const,
    label: 'Chat',
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
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
  {
    id: 'about' as const,
    label: 'About',
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
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
  },
  {
    id: 'policies' as const,
    label: 'Policies',
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
        <path d="M12 2 L4 5 V11 C4 16 8 20 12 22 C16 20 20 16 20 11 V5 Z" />
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

function TabsBar({
  activeTab,
  onSelect,
  chatDot,
}: {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  chatDot: boolean;
}) {
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
              {tab.id === 'chat' && chatDot && (
                <span
                  aria-label="Unseen results"
                  className="size-6 shrink-0 rounded-full bg-stat-emerald"
                />
              )}
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

export default function AgentPage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = params.pubkey ?? '';
  const isValidPubkey = HEX_PUBKEY_RE.test(pubkey);
  const [, setLocation] = useLocation();
  const search = useSearch();

  const { agent, status: agentStatus } = useAgent(pubkey);
  // `useAgent` exposes a single fetch for this author, so feedback can use
  // the same gating it used to derive from the global stream's lifecycle:
  // wait until the targeted fetch has resolved (or failed) before issuing
  // the feedback batch.
  const feedbackGate = agentStatus === 'ready' || agentStatus === 'not-found' ? 'eose' : 'idle';
  const { data: feedbackMap } = useAgentFeedback(pubkey ? [pubkey] : [], feedbackGate);
  const displayAgents = useAgentDisplay(agent ? [agent] : [], feedbackMap);
  const agentData = agent ? displayAgents[0] : undefined;

  const idCtx = useIdentity();
  const { publicKey: walletPublicKey } = useWallet();
  const isOwn = idCtx.publicKey === pubkey;
  const pingedStatus = usePingAgent(isOwn || !pubkey ? '' : pubkey);
  const pingStatus: PingStatus = isOwn ? 'online' : pingedStatus;

  const [selectedCardIndex, setSelectedCardIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>('products');
  const [appeared, setAppeared] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAppeared(true), APPEAR_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);
  const appearCls = appeared ? '' : 'appear';

  // Thread store snapshot (all identities) + background relay hydration into
  // it. Hydration keeps its page-mount laziness (starts when the page's data
  // is needed, exactly as the retired artifact hydration did).
  const { entries: threadEntries, loaded: threadLoaded } = useChatThread(pubkey);
  const { hydrating } = useChatHydration(isValidPubkey ? pubkey : '');
  const identityEntries = useMemo(
    () => identityThreadEntries(threadEntries, idCtx.publicKey),
    [threadEntries, idCtx.publicKey],
  );

  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const nostrBanner = agent?.banner;

  // Unseen badge: the `elisym:unseen-artifacts:<agentPubkey>` store keeps its
  // key; its reader is now the dot on the Chat tab label. The store is
  // agent-keyed and survives logout, so the reader intersects the stored ids
  // with the current identity's rendered entries - identity B never shows a
  // badge for identity A's completions, and purged/trimmed ids are inert.
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

  // Page-owned completion observer (replacing the retired ArtifactCapturer's
  // bridge role): watch the thread store for pending/failed -> completed
  // transitions and, when one fires while the Chat tab is not active AND the
  // entry is stamped with the current identity, record the id as unseen.
  // BuyContext keeps zero knowledge of tabs.
  const prevStatusRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!threadLoaded) {
      return;
    }
    const prev = prevStatusRef.current;
    const next = new Map<string, string>();
    for (const entry of threadEntries) {
      next.set(entry.jobEventId, entry.status ?? 'completed');
    }
    prevStatusRef.current = next;
    if (prev === null) {
      // First snapshot: nothing transitioned within this tab's observation.
      return;
    }
    const completedNow: string[] = [];
    for (const entry of threadEntries) {
      if (entry.customerPubkey !== idCtx.publicKey || entry.status !== undefined) {
        continue;
      }
      const before = prev.get(entry.jobEventId);
      if (before !== undefined && before !== 'completed') {
        completedNow.push(entry.jobEventId);
      }
    }
    if (completedNow.length === 0 || activeTab === 'chat') {
      return;
    }
    setUnseenArtifactIds((prevIds) => {
      const nextIds = new Set(prevIds);
      for (const id of completedNow) {
        nextIds.add(id);
      }
      persistUnseen(nextIds);
      return nextIds;
    });
  }, [threadEntries, threadLoaded, activeTab, idCtx.publicKey, persistUnseen]);

  // The badge clears when the Chat tab becomes active (the messenger unread
  // pattern). Only the current identity's rendered ids are cleared - other
  // identities' stored ids stay for their own next visit.
  useEffect(() => {
    if (activeTab !== 'chat') {
      return;
    }
    setUnseenArtifactIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const rendered = new Set(identityEntries.map((entry) => entry.jobEventId));
      const next = new Set([...prev].filter((id) => !rendered.has(id)));
      if (next.size === prev.size) {
        return prev;
      }
      persistUnseen(next);
      return next;
    });
  }, [activeTab, identityEntries, persistUnseen]);

  const chatDot = useMemo(() => {
    if (unseenArtifactIds.size === 0 || activeTab === 'chat') {
      return false;
    }
    return identityEntries.some((entry) => unseenArtifactIds.has(entry.jobEventId));
  }, [unseenArtifactIds, identityEntries, activeTab]);

  // ?tab=history lands the user straight on the Chat tab (the History tab it
  // used to point at is now the chat). Kept as an alias so old links and the
  // `Result received` toast's "View" action keep working.
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get('tab') === 'history') {
      setActiveTab('chat');
      // Strip the param so a refresh / back-nav doesn't keep forcing the
      // tab and the URL stays clean once the intent has been honored.
      params.delete('tab');
      const remaining = params.toString();
      setLocation(`/agent/${pubkey}${remaining ? `?${remaining}` : ''}`, { replace: true });
    }
  }, [search, pubkey, setLocation]);

  const displayName =
    agentData?.name || (isValidPubkey ? truncateKey(nip19.npubEncode(pubkey), 8) : '');

  // Hoisted above early returns: useBuyForCard is a hook and must run on
  // every render, including the loading / not-found branches.
  const cards = agentData?.cards ?? [];
  const currentCardIndex = Math.min(selectedCardIndex, Math.max(0, cards.length - 1));
  const currentCard = cards[currentCardIndex];
  const buyState = useBuyForCard({
    agentPubkey: pubkey,
    agentName: agentData?.name ?? '',
    agentPicture: agentData?.picture,
    card: currentCard,
  });

  // A malformed pubkey can never resolve to an agent and would crash the
  // `nip19.npubEncode` paths below, so route it straight to NotFound.
  if (!isValidPubkey) {
    return <NotFound />;
  }

  if (!agentData) {
    if (agentStatus === 'not-found') {
      return <NotFound />;
    }
    return <LoadingOverlay />;
  }

  // Gate on total, not positives: an all-negative agent (0 positive, N total) must
  // still show "0% positive", otherwise it looks identical to a brand-new unrated
  // agent and the negative trust signal is hidden.
  const feedbackPct =
    agentData.feedbackTotal > 0
      ? Math.round((agentData.feedbackPositive / agentData.feedbackTotal) * 100)
      : null;
  const clampedDisplayName =
    displayName.length > MAX_DISPLAY_NAME
      ? `${displayName.slice(0, MAX_DISPLAY_NAME)}…`
      : displayName;

  function handleBackClick() {
    setLocation('/');
  }

  async function copyWallet() {
    if (!agentData?.walletAddress) {
      return;
    }
    await navigator.clipboard.writeText(agentData.walletAddress);
    toast.success('Wallet address copied');
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
            <div className="relative h-full w-full overflow-hidden bg-[#ededed]">
              <img
                aria-hidden
                src="/logo-black.png"
                alt=""
                className="absolute top-1/2 left-1/2 h-21 -translate-x-1/2 -translate-y-1/2 opacity-20 sm:h-30"
              />
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
                      // Provider-controlled URL (https-validated in the SDK): don't leak
                      // the inspected pubkey via Referer to the image host.
                      referrerPolicy="no-referrer"
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
                    <span
                      className="flex items-center gap-6"
                      title="From buyers who signed the job request (Nostr-verified). On-chain payment verification is not applied yet."
                    >
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
                      <span className="text-text-2">
                        ({agentData.feedbackTotal} verified
                        {agentData.feedbackTotalAllTiers > agentData.feedbackTotal
                          ? ` · ${agentData.feedbackTotalAllTiers} total`
                          : ''}
                        )
                      </span>
                    </span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-start gap-8 sm:items-end">
                {!isOwn && (walletPublicKey !== null || idCtx.providerSession) && (
                  <Link
                    to={`/messages/${pubkey}`}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-6 rounded-8 border border-border px-10 py-6 text-xs font-medium text-text-2 no-underline transition-colors hover:border-accent hover:text-text"
                  >
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
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Message
                  </Link>
                )}
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
        </div>

        {/* Single-column layout: About lives on its own tab, so every tab -
            the chat especially - gets the full page width. */}
        <div className="flex min-w-0 flex-col gap-16">
          {/* Tabs + content */}
          <div
            ref={tabsContainerRef}
            className={cn(
              appearCls,
              'scroll-mt-16 rounded-3xl border border-black/7 bg-surface p-14 shadow-[0_1px_8px_rgba(0,0,0,0.05)] [animation-delay:80ms] sm:p-20',
            )}
          >
            <TabsBar activeTab={activeTab} onSelect={setActiveTab} chatDot={chatDot} />

            {activeTab === 'products' && (
              <ProductsTab
                cards={cards}
                selectedCardIndex={selectedCardIndex}
                onSelect={setSelectedCardIndex}
              />
            )}

            {activeTab === 'chat' && (
              <ChatTab
                agentPubkey={pubkey}
                agentName={agentData.name}
                agentPicture={agentData.picture}
                pingStatus={pingStatus}
                cards={cards}
                selectedIndex={currentCardIndex}
                onSelectIndex={setSelectedCardIndex}
                buyState={buyState}
                entries={identityEntries}
                loading={!threadLoaded || (identityEntries.length === 0 && hydrating)}
              />
            )}

            {activeTab === 'activity' && (
              <AgentActivity agentPubkey={pubkey} productCount={cards.length} />
            )}

            {activeTab === 'about' && (
              <AboutTab description={agentData.description} tags={agentData.tags} />
            )}

            {activeTab === 'policies' && <PoliciesPanel pubkey={pubkey} />}
          </div>

          {cards.length > 0 && activeTab === 'products' && (
            <>
              <div
                className={cn(
                  appearCls,
                  'relative sticky bottom-[var(--devnet-banner-h,0px)] z-40 -mx-12 [animation-delay:160ms] lg:static lg:bottom-auto lg:mx-0',
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
        </div>
      </div>
    </div>
  );
}

function AboutTab({ description, tags }: { description: string; tags: string[] }) {
  if (!description && tags.length === 0) {
    return <p className="py-24 text-center text-sm text-text-2">No description yet.</p>;
  }
  return (
    <div className="max-w-[720px]">
      {description && <p className="m-0 text-sm leading-relaxed text-text-2">{description}</p>}
      {tags.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-6', description && 'mt-16')}>
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-24 items-center rounded-full bg-tag-bg px-10 font-mono text-[11px] leading-none font-medium tracking-wide text-text-2 uppercase"
            >
              {tag}
            </span>
          ))}
        </div>
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
