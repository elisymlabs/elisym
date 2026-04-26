import { compareAgentsByRank } from '@elisym/sdk';
import { useState, useEffect, useRef, useMemo, useDeferredValue, useCallback } from 'react';
import { AgentCard } from '~/components/AgentCard';
import { AgentCardSkeleton } from '~/components/AgentCardSkeleton';
import { FilterBar } from '~/components/FilterBar';
import { HeroSection } from '~/components/HeroSection';
import { useUI, type ViewMode } from '~/contexts/UIContext';
import type { AgentDisplayData } from '~/hooks/useAgentDisplay';
import { useAgentDisplay } from '~/hooks/useAgentDisplay';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { useStats } from '~/hooks/useStats';
import { findTagFilter, findViewMode } from '~/lib/categories';
import { cn } from '~/lib/cn';
import { VERIFIED_PUBKEYS } from '~/lib/verified';

const PAGE_SIZE = 18;
const PAGE_FADE_MS = 180;

/** Compact page numbers: [1, '...', current, '...', total] - max 4 items */
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 4) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages: (number | '...')[] = [1];
  if (current > 2) {
    pages.push('...');
  }
  if (current !== 1 && current !== total) {
    pages.push(current);
  }
  if (current < total - 1) {
    pages.push('...');
  }
  pages.push(total);
  return pages;
}

function applyViewMode(agents: AgentDisplayData[], viewMode: ViewMode): AgentDisplayData[] {
  const mode = findViewMode(viewMode);
  if (!mode) {
    return agents;
  }
  return agents.filter((agent) => mode.match(agent));
}

/** OR semantics: agent matches if it satisfies any selected tag filter. Empty selection passes through. */
function applyTagFilter(agents: AgentDisplayData[], selectedTags: string[]): AgentDisplayData[] {
  if (selectedTags.length === 0) {
    return agents;
  }
  const matchers = selectedTags
    .map((tag) => findTagFilter(tag))
    .filter((filter): filter is NonNullable<typeof filter> => filter !== undefined);
  if (matchers.length === 0) {
    return agents;
  }
  return agents.filter((agent) => matchers.some((filter) => filter.match(agent)));
}

function applySearchFilter(agents: AgentDisplayData[], query: string): AgentDisplayData[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return agents;
  }
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(normalized) ||
      agent.description.toLowerCase().includes(normalized) ||
      agent.tags.some((tag) => tag.toLowerCase().includes(normalized)) ||
      agent.cards.some((card) => card.name.toLowerCase().includes(normalized)),
  );
}

/**
 * Global ordering by SDK ranking. `compareAgentsByRank` (SDK 0.10) groups by
 * `lastPaidJobAt` in 1-minute slots, then sorts by positive review rate, then
 * tiebreaks by raw `lastPaidJobAt` / `lastSeen`. Cold-start agents (no
 * verified paid job) land in the `-Infinity` bucket and therefore always
 * follow agents that have any verified paid job - matching the user's
 * expectation that an agent with a more recent paid job ranks higher
 * regardless of NIP-89 freshness.
 *
 * No online/offline split: `lastSeen` (NIP-89 freshness) is dominated by
 * heartbeat capability publishes and is not a reliable signal of "did real
 * work recently".
 */
function sortByRank(agents: AgentDisplayData[]): AgentDisplayData[] {
  return [...agents].sort((a, b) => compareAgentsByRank(a.agent, b.agent));
}

function sortByNewest(agents: AgentDisplayData[]): AgentDisplayData[] {
  return [...agents].sort((a, b) => b.lastSeenTs - a.lastSeenTs);
}

export default function Home() {
  const { data: agents, isLoading: agentsLoading } = useAgents();
  useStats();
  const agentPubkeys = useMemo(() => (agents ?? []).map((agent) => agent.pubkey), [agents]);
  const { data: feedbackMap } = useAgentFeedback(agentPubkeys);
  const displayAgents = useAgentDisplay(agents ?? [], feedbackMap);
  const [state] = useUI();
  const [page, setPage] = useState(() => {
    if (typeof sessionStorage === 'undefined') {
      return 1;
    }
    const saved = sessionStorage.getItem('home-page');
    return saved ? Math.max(1, parseInt(saved, 10) || 1) : 1;
  });

  useEffect(() => {
    sessionStorage.setItem('home-page', String(page));
  }, [page]);

  const [gridOpaque, setGridOpaque] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);

  const goToPage = useCallback((target: number) => {
    setGridOpaque(false);
    setTimeout(() => {
      setPage(target);
      setGridOpaque(true);
      gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, PAGE_FADE_MS);
  }, []);

  const filtered = useMemo(() => {
    const byView = applyViewMode(displayAgents, state.viewMode);
    const byTags = applyTagFilter(byView, state.selectedTags);
    const bySearch = applySearchFilter(byTags, searchQuery);
    return state.viewMode === 'new' ? sortByNewest(bySearch) : sortByRank(bySearch);
  }, [displayAgents, state.viewMode, state.selectedTags, searchQuery]);

  const filterSignature = `${state.viewMode}|${state.selectedTags.join(',')}|${searchQuery}`;
  const prevSignature = useRef(filterSignature);
  useEffect(() => {
    if (prevSignature.current !== filterSignature) {
      prevSignature.current = filterSignature;
      setPage(1);
    }
  }, [filterSignature]);

  const deferredFiltered = useDeferredValue(filtered);
  const totalPages = Math.max(1, Math.ceil(deferredFiltered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = deferredFiltered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  let content: React.ReactNode;
  if (agentsLoading) {
    content = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-14 sm:gap-20">
        {Array.from({ length: PAGE_SIZE }).map((_, index) => (
          <AgentCardSkeleton key={index} />
        ))}
      </div>
    );
  } else if (filtered.length === 0) {
    content = <p className="py-60 text-center text-text-2">No agents found for this category.</p>;
  } else {
    content = (
      <>
        <div
          className={cn(
            'grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-14 transition-opacity duration-[180ms] sm:gap-20',
            gridOpaque ? 'opacity-100' : 'opacity-0',
          )}
        >
          {paged.map((agent, index) => (
            <AgentCard
              key={agent.pubkey}
              agent={agent}
              isVerified={VERIFIED_PUBKEYS.has(agent.pubkey)}
              index={index}
            />
          ))}
        </div>

        {deferredFiltered.length > 0 && (
          <div className="mt-28 mb-24 flex items-center justify-center gap-4 sm:mt-40 sm:mb-[120px]">
            <button
              onClick={() => goToPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              aria-label="Previous page"
              className="flex size-40 cursor-pointer items-center justify-center rounded-xl bg-surface-2 text-base font-medium text-text-2 transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-30"
            >
              ‹
            </button>

            {getPageNumbers(safePage, totalPages).map((entry, index) =>
              entry === '...' ? (
                <span
                  key={`dot-${index}`}
                  className="flex size-40 items-center justify-center text-sm text-text-2/60"
                >
                  ···
                </span>
              ) : (
                <button
                  key={entry}
                  onClick={() => goToPage(entry)}
                  aria-label={`Page ${entry}`}
                  aria-current={entry === safePage ? 'page' : undefined}
                  className={cn(
                    'size-40 cursor-pointer rounded-xl text-sm font-medium transition-colors',
                    entry === safePage
                      ? 'bg-surface-dark text-white'
                      : 'bg-surface-2 text-text-2 hover:bg-border',
                  )}
                >
                  {entry}
                </button>
              ),
            )}

            <button
              onClick={() => goToPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
              aria-label="Next page"
              className="flex size-40 cursor-pointer items-center justify-center rounded-xl bg-surface-2 text-base font-medium text-text-2 transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-30"
            >
              ›
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <HeroSection />

      <div
        id="light-content"
        ref={gridRef}
        className="relative z-[1] -mt-24 min-h-screen scroll-mt-65 rounded-t-[28px] bg-surface sm:-mt-40 sm:rounded-t-[40px]"
      >
        <div className="mx-auto max-w-6xl px-16 pt-24 pb-32 sm:px-24 sm:pt-56">
          <FilterBar searchQuery={searchQuery} onSearchChange={setSearchQuery} />
          {content}
        </div>
      </div>
    </>
  );
}
