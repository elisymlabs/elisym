import { useState, useEffect, useRef, useMemo, useDeferredValue, useCallback } from 'react';
import { AgentCard } from '~/components/AgentCard';
import { AgentCardSkeleton } from '~/components/AgentCardSkeleton';
import { FilterBar, KNOWN_CATEGORIES } from '~/components/FilterBar';
import { HeroSection } from '~/components/HeroSection';
import { useUI } from '~/contexts/UIContext';
import { useAgentDisplay } from '~/hooks/useAgentDisplay';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { useStats } from '~/hooks/useStats';

const VERIFIED_PUBKEYS = new Set([
  '88b38bac4c1637a2a822eda279f6b2617752ac4ffb631ec7d04c4262cfa2510b',
  '0fbc5c6954fbc4c517fa158f81cbc10ea1940408af027a5bf9b46625f738aac3',
  '46b3c17fb7a36d375ea9d8e89e103f22f48ea7005852fd9590d1651425d72a53',
  '3e85c0f19c61d3f0c8926a50af2709f05dc3e223689b14ea824b6df98b1b68c9',
  '9ab1159ecf8cdad74793eb3890d88eff2a355fa25b0c37d462640f1727f57c59',
  '13fec8e2de4ff3348dba478670d67c247da06d49d821e61e322635463959770b',
  '7ed76f64670efc68522727a298d0267e705a82902e0466e3d5ac158cad0364c5',
  '06a738615c5c2239e3805de6680335d759bbb30b92c217c66dc8d805bafd8b91',
]);

/** Compact page numbers: [1, '...', current, '...', total] — max 4 items */
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 4) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '...')[] = [1];
  if (current > 2) pages.push('...');
  if (current !== 1 && current !== total) pages.push(current);
  if (current < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

const PAGE_SIZE = 18;

export default function Home() {
  const { data: agents, isLoading: agentsLoading } = useAgents();
  useStats();
  const agentPubkeys = useMemo(() => (agents ?? []).map((a) => a.pubkey), [agents]);
  const { data: feedbackMap } = useAgentFeedback(agentPubkeys);
  const displayAgents = useAgentDisplay(agents ?? [], feedbackMap);
  const [state] = useUI();
  const [page, setPage] = useState(() => {
    if (typeof sessionStorage === 'undefined') return 1;
    const saved = sessionStorage.getItem('home-page');
    return saved ? Math.max(1, parseInt(saved, 10) || 1) : 1;
  });

  useEffect(() => {
    sessionStorage.setItem('home-page', String(page));
  }, [page]);
  const [gridOpacity, setGridOpacity] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);

  const goToPage = useCallback((p: number) => {
    setGridOpacity(0);
    setTimeout(() => {
      setPage(p);
      setGridOpacity(1);
      gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 180);
  }, []);

  const filteredUnsorted = (() => {
    if (state.currentFilter === 'all') return displayAgents;
    if (state.currentFilter === 'other') {
      return displayAgents.filter((a) =>
        a.tags.some((t) => !KNOWN_CATEGORIES.includes(t.toLowerCase())),
      );
    }
    return displayAgents.filter((a) =>
      a.tags.some((t) => t.toLowerCase().includes(state.currentFilter.toLowerCase())),
    );
  })();

  const searchFiltered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return filteredUnsorted;
    return filteredUnsorted.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)) ||
        a.cards.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [filteredUnsorted, searchQuery]);

  const filtered = useMemo(() => {
    const TEN_MINUTES = 10 * 60;
    const now = Math.floor(Date.now() / 1000);
    const positiveRate = (a: (typeof searchFiltered)[number]) =>
      a.feedbackTotal > 0 ? a.feedbackPositive / a.feedbackTotal : 0;
    const online = searchFiltered.filter((a) => now - a.lastSeenTs < TEN_MINUTES);
    const rest = searchFiltered.filter((a) => now - a.lastSeenTs >= TEN_MINUTES);
    online.sort((a, b) => {
      const rateDiff = positiveRate(b) - positiveRate(a);
      return rateDiff !== 0 ? rateDiff : b.lastSeenTs - a.lastSeenTs;
    });
    rest.sort((a, b) => b.lastSeenTs - a.lastSeenTs);
    return [...online, ...rest];
  }, [searchFiltered]);

  const prevFilter = useRef(state.currentFilter);
  useEffect(() => {
    if (prevFilter.current !== state.currentFilter) {
      prevFilter.current = state.currentFilter;
      setPage(1);
    }
  }, [state.currentFilter]);

  const prevSearch = useRef(searchQuery);
  useEffect(() => {
    if (prevSearch.current !== searchQuery) {
      prevSearch.current = searchQuery;
      setPage(1);
    }
  }, [searchQuery]);

  const deferredFiltered = useDeferredValue(filtered);
  const totalPages = Math.max(1, Math.ceil(deferredFiltered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = deferredFiltered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <HeroSection />

      <div
        id="light-content"
        ref={gridRef}
        className="bg-surface min-h-screen rounded-t-[40px] -mt-10 relative"
        style={{ scrollMarginTop: '65px', zIndex: 1 }}
      >
        <div className="max-w-6xl mx-auto pt-14 pb-8 px-6">
          <FilterBar searchQuery={searchQuery} onSearchChange={setSearchQuery} />

          {agentsLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-5">
              {Array.from({ length: PAGE_SIZE }).map((_, i) => (
                <AgentCardSkeleton key={i} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-text-2 text-center py-15">No agents found for this category.</p>
          ) : (
            <>
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-5"
                style={{ opacity: gridOpacity, transition: 'opacity 0.18s ease' }}
              >
                {paged.map((agent) => (
                  <AgentCard
                    key={agent.pubkey}
                    agent={agent}
                    isVerified={VERIFIED_PUBKEYS.has(agent.pubkey)}
                    index={paged.indexOf(agent)}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-1 mt-10 mb-[120px]">
                  <button
                    onClick={() => goToPage(Math.max(1, safePage - 1))}
                    disabled={safePage === 1}
                    className="size-10 rounded-xl flex items-center justify-center text-base font-medium bg-[#f0f0f0] text-[#444] hover:bg-[#e4e4e4] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    ‹
                  </button>

                  {getPageNumbers(safePage, totalPages).map((p, i) =>
                    p === '...' ? (
                      <span
                        key={`dot-${i}`}
                        className="size-10 flex items-center justify-center text-sm text-[#999]"
                      >
                        ···
                      </span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => goToPage(p as number)}
                        className={`size-10 rounded-xl text-sm font-medium cursor-pointer transition-colors ${
                          p === safePage
                            ? 'bg-[#101012] text-white'
                            : 'bg-[#f0f0f0] text-[#444] hover:bg-[#e4e4e4]'
                        }`}
                      >
                        {p}
                      </button>
                    ),
                  )}

                  <button
                    onClick={() => goToPage(Math.min(totalPages, safePage + 1))}
                    disabled={safePage === totalPages}
                    className="size-10 rounded-xl flex items-center justify-center text-base font-medium bg-[#f0f0f0] text-[#444] hover:bg-[#e4e4e4] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    ›
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
