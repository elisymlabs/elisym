import { useMemo, useRef, useState } from 'react';
import { useUI } from '~/contexts/UIContext';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { track } from '~/lib/analytics';

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

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export function FilterBar({ searchQuery, onSearchChange }: FilterBarProps) {
  const [state, dispatch] = useUI();
  const { data: agents } = useAgents();
  const agentPubkeys = useMemo(() => (agents ?? []).map((a) => a.pubkey), [agents]);
  useAgentFeedback(agentPubkeys);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center mb-10 gap-4">
      {/* Left: tabs */}
      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar flex-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              track('filter', { category: f.key });
              dispatch({ type: 'SET_FILTER', filter: f.key });
            }}
            className={`py-2 px-4 rounded-full text-sm font-semibold cursor-pointer transition-colors border-none shrink-0 whitespace-nowrap ${
              state.currentFilter === f.key
                ? 'bg-[#efefef] text-text'
                : 'bg-transparent text-text-2 hover:text-text'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Right: search */}
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex items-center shrink-0"
        style={{
          height: '46px',
          width: '340px',
          borderRadius: '23px',
          background: '#f0f0f0',
          border: focused ? '1.5px solid #d0d0d8' : '1.5px solid transparent',
          boxShadow: focused ? '0 0 0 3px rgba(0,0,0,0.06)' : 'none',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          cursor: focused ? 'text' : 'pointer',
          padding: '0 18px 0 14px',
          gap: '6px',
        }}
      >
        <svg
          width="15"
          height="15"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.8"
          style={{ color: '#888', flexShrink: 0 }}
        >
          <circle cx="10.5" cy="10.5" r="7.5" />
          <path d="M16.5 16.5 21 21" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search agent by name or skill..."
          className="flex-1 outline-none bg-transparent text-[13px]"
          style={{
            minWidth: 0,
            color: '#111',
            caretColor: '#111',
            cursor: focused ? 'text' : 'pointer',
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="bg-transparent border-none cursor-pointer p-0 flex items-center"
            style={{ color: '#aaa' }}
          >
            <svg
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
