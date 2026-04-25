import { useRef, useState } from 'react';
import { useUI } from '~/contexts/UIContext';
import { useScrollEdges } from '~/hooks/useScrollEdges';
import { track } from '~/lib/analytics';
import { CATEGORIES } from '~/lib/categories';
import { cn } from '~/lib/cn';

const PILL_CLASSES =
  'shrink-0 cursor-pointer rounded-full border-none px-16 py-8 text-sm font-semibold whitespace-nowrap transition-colors';

interface Props {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function FilterBar({ searchQuery, onSearchChange }: Props) {
  const [state, dispatch] = useUI();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { atStart, atEnd } = useScrollEdges(scrollRef);

  return (
    <div className="mb-24 flex flex-col gap-20 sm:mb-40 sm:flex-row sm:items-center sm:gap-12">
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          className="no-scrollbar flex items-center gap-4 overflow-x-auto scroll-smooth sm:px-12"
        >
          {CATEGORIES.map((filter, index) => {
            const isFirst = index === 0;
            const isLast = index === CATEGORIES.length - 1;
            return (
              <button
                key={filter.key}
                onClick={(event) => {
                  track('filter', { category: filter.key });
                  dispatch({ type: 'SET_FILTER', filter: filter.key });
                  const container = scrollRef.current;
                  if (!container) {
                    return;
                  }
                  if (isFirst) {
                    container.scrollTo({ left: 0, behavior: 'smooth' });
                  } else if (isLast) {
                    container.scrollTo({
                      left: container.scrollWidth,
                      behavior: 'smooth',
                    });
                  } else {
                    event.currentTarget.scrollIntoView({
                      behavior: 'smooth',
                      inline: 'nearest',
                      block: 'nearest',
                    });
                  }
                }}
                className={cn(
                  PILL_CLASSES,
                  state.currentFilter === filter.key
                    ? 'bg-surface-2 text-text'
                    : 'bg-transparent text-text-2 hover:text-text',
                )}
              >
                {filter.label}
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

      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex h-46 w-full shrink-0 items-center gap-6 rounded-full border-[1.5px] bg-surface-2 pr-18 pl-14 transition-[border-color,box-shadow] duration-150 sm:w-340',
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
