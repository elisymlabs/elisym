import type { CapabilityCard } from '@elisym/sdk';
import { useState, useRef, useEffect } from 'react';
import { cn } from '~/lib/cn';

interface Props {
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}

export function CapabilityDropdown({ cards, selectedIndex, onSelectIndex }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const multiple = cards.length > 1;
  const current = cards[selectedIndex];

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => multiple && setOpen((current) => !current)}
        disabled={!multiple}
        className={cn(
          'inline-flex h-28 items-center rounded-full bg-tag-bg pl-12 text-[11px] font-semibold tracking-wide text-text-2 uppercase transition-colors outline-none',
          multiple ? 'cursor-pointer pr-32 hover:bg-tag-bg/80' : 'cursor-default pr-12',
        )}
      >
        <span className="max-w-[200px] truncate">{current?.name}</span>
        {multiple && (
          <svg
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1/2 right-10 size-16 -translate-y-1/2 text-text-2 transition-transform',
              open && 'rotate-180',
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {open && multiple && (
        <div className="absolute bottom-full left-0 z-50 mb-8 flex min-w-[180px] origin-bottom-left [animation:dropdown-in_120ms_cubic-bezier(0.2,0.8,0.2,1)] flex-col gap-2 rounded-2xl border border-black/6 bg-surface/95 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-xl">
          {cards.map((card, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={card.name}
                type="button"
                onClick={() => {
                  onSelectIndex(index);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-8 rounded-10 py-8 pr-12 pl-10 text-left text-xs font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-surface-2 text-text'
                    : 'text-text-2 hover:bg-surface-2/60 hover:text-text',
                )}
              >
                <svg
                  aria-hidden
                  className={cn(
                    'size-14 shrink-0 transition-opacity',
                    active ? 'text-text-2 opacity-100' : 'opacity-0',
                  )}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>{card.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
