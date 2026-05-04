import { useLayoutEffect, useRef, useState } from 'react';
import { useUI, type ViewMode } from '~/contexts/UIContext';
import { useScrollEdges } from '~/hooks/useScrollEdges';
import { track } from '~/lib/analytics';
import { TAG_FILTERS, VIEW_MODES } from '~/lib/categories';
import { cn } from '~/lib/cn';

const SWITCHER_TRACK_CLASSES =
  'relative flex shrink-0 items-center gap-2 rounded-full border border-white/60 bg-tag-bg p-3 backdrop-blur-md';
const SWITCHER_PILL_CLASSES =
  'relative z-10 cursor-pointer touch-manipulation rounded-full border-none bg-transparent px-14 py-6 text-[13px] font-medium whitespace-nowrap transition-colors duration-200 sm:text-sm';
const SWITCHER_PILL_ACTIVE = 'text-text';
const SWITCHER_PILL_INACTIVE = 'text-text-2 hover:text-text';
const SWITCHER_INDICATOR_CLASSES =
  'pointer-events-none absolute top-3 bottom-3 left-0 rounded-full bg-white shadow-card transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[transform,width]';

const TAG_CHIP_CLASSES =
  'inline-flex h-28 shrink-0 cursor-pointer touch-manipulation items-center rounded-full border px-14 font-mono text-[11px] leading-none font-medium tracking-wide whitespace-nowrap uppercase transition-[background-color,color,border-color,box-shadow] duration-200';
const TAG_CHIP_ACTIVE = 'border-transparent bg-surface-dark text-white shadow-card';
const TAG_CHIP_INACTIVE =
  'border-black/10 bg-transparent text-text-2 hover:border-black/20 hover:text-text';

interface Props {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function FilterBar({ searchQuery, onSearchChange }: Props) {
  const [state, dispatch] = useUI();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const switcherTrackRef = useRef<HTMLDivElement>(null);
  const switcherPillRefs = useRef<Map<ViewMode, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const { atStart, atEnd } = useScrollEdges(scrollRef);

  useLayoutEffect(() => {
    const pill = switcherPillRefs.current.get(state.viewMode);
    const trackEl = switcherTrackRef.current;
    if (!pill || !trackEl) {
      return;
    }
    const measure = () => {
      const left = pill.offsetLeft;
      const width = pill.offsetWidth;
      setIndicator((prev) =>
        prev && prev.left === left && prev.width === width ? prev : { left, width },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    observer.observe(trackEl);
    return () => observer.disconnect();
  }, [state.viewMode]);

  return (
    <div className="mb-24 flex flex-col gap-20 sm:mb-40 sm:flex-row sm:items-center sm:gap-16">
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          className="no-scrollbar flex items-center gap-8 overflow-x-auto scroll-smooth sm:pr-12"
        >
          <div ref={switcherTrackRef} className={SWITCHER_TRACK_CLASSES}>
            {indicator && (
              <span
                aria-hidden
                className={SWITCHER_INDICATOR_CLASSES}
                style={{
                  transform: `translateX(${indicator.left}px)`,
                  width: `${indicator.width}px`,
                }}
              />
            )}
            {VIEW_MODES.map((mode) => {
              const isActive = state.viewMode === mode.key;
              return (
                <button
                  key={mode.key}
                  ref={(button) => {
                    if (button) {
                      switcherPillRefs.current.set(mode.key, button);
                    } else {
                      switcherPillRefs.current.delete(mode.key);
                    }
                  }}
                  onClick={() => {
                    track('view_mode', { mode: mode.key });
                    dispatch({ type: 'SET_VIEW_MODE', viewMode: mode.key });
                  }}
                  aria-pressed={isActive}
                  className={cn(
                    SWITCHER_PILL_CLASSES,
                    isActive ? SWITCHER_PILL_ACTIVE : SWITCHER_PILL_INACTIVE,
                  )}
                >
                  {mode.key === 'verified' && (
                    <svg
                      aria-hidden
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className={cn(
                        '-mt-1 mr-4 inline-block align-middle',
                        isActive ? 'text-[#1d9bf0]' : 'text-text-2/50',
                      )}
                    >
                      <path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334-4.334 6.5c-.145.217-.382.354-.643.366-.012.001-.024 0-.037 0-.247 0-.48-.11-.638-.302l-2.5-3c-.282-.34-.237-.84.1-1.123.342-.282.842-.24 1.124.1l1.832 2.2 3.692-5.54c.23-.345.696-.436 1.04-.207.346.23.44.696.207 1.04z" />
                    </svg>
                  )}
                  {mode.label}
                </button>
              );
            })}
          </div>

          <span aria-hidden className="mx-10 h-20 w-px shrink-0 self-center bg-black/10" />

          {TAG_FILTERS.map((filter) => {
            const isActive = state.selectedTags.includes(filter.key);
            return (
              <button
                key={filter.key}
                onClick={(event) => {
                  track('tag_filter', { tag: filter.key, action: isActive ? 'remove' : 'add' });
                  dispatch({ type: 'TOGGLE_TAG', tag: filter.key });
                  event.currentTarget.scrollIntoView({
                    behavior: 'smooth',
                    inline: 'nearest',
                    block: 'nearest',
                  });
                }}
                aria-pressed={isActive}
                className={cn(TAG_CHIP_CLASSES, isActive ? TAG_CHIP_ACTIVE : TAG_CHIP_INACTIVE)}
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
