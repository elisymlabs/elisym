import { useMemo, useRef, useState } from 'react';
import { useUI } from '~/contexts/UIContext';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';

export const KNOWN_CATEGORIES = ['ui-ux', 'summary', 'tools', 'code', 'data'];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'ui-ux', label: 'UI/UX' },
  { key: 'summary', label: 'Summary' },
  { key: 'tools', label: 'Tools' },
  { key: 'code', label: 'Code' },
  { key: 'data', label: 'Data' },
  { key: 'other', label: 'Other' },
];

interface Props {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function FilterBar({ searchQuery, onSearchChange }: Props) {
  const [state, dispatch] = useUI();
  const { data: agents } = useAgents();
  const agentPubkeys = useMemo(() => (agents ?? []).map((agent) => agent.pubkey), [agents]);
  useAgentFeedback(agentPubkeys);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mb-40 flex items-center gap-16">
      <div className="no-scrollbar flex flex-1 items-center gap-4 overflow-x-auto">
        {FILTERS.map((filter) => (
          <button
            key={filter.key}
            onClick={() => {
              track('filter', { category: filter.key });
              dispatch({ type: 'SET_FILTER', filter: filter.key });
            }}
            className={cn(
              'shrink-0 cursor-pointer rounded-full border-none px-16 py-8 text-sm font-semibold whitespace-nowrap transition-colors',
              state.currentFilter === filter.key
                ? 'bg-surface-2 text-text'
                : 'bg-transparent text-text-2 hover:text-text',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex h-46 w-340 shrink-0 items-center gap-6 rounded-full border-[1.5px] bg-surface-2 pr-18 pl-14 transition-[border-color,box-shadow] duration-150',
          focused
            ? 'cursor-text border-[#d0d0d8] shadow-[0_0_0_3px_rgba(0,0,0,0.06)]'
            : 'cursor-pointer border-transparent',
        )}
      >
        <svg
          aria-hidden
          width="15"
          height="15"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.8"
          className="shrink-0 text-text-2"
        >
          <circle cx="10.5" cy="10.5" r="7.5" />
          <path d="M16.5 16.5 21 21" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search agent by name or skill..."
          className={cn(
            'min-w-0 flex-1 bg-transparent text-[13px] text-text caret-text outline-none',
            focused ? 'cursor-text' : 'cursor-pointer',
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="flex cursor-pointer items-center border-none bg-transparent p-0 text-text-2/70"
          >
            <svg
              aria-hidden
              width="16"
              height="16"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
