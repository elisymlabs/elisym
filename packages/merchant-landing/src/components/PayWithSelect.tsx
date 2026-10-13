import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ChainMark } from './ChainMark';
import type { MockPayout } from './CheckoutMock';

interface Props {
  payouts: readonly MockPayout[];
  selected: MockPayout;
  onSelect: (id: string) => void;
}

function payoutText(payout: MockPayout): string {
  return `${payout.coin} · ${payout.chainLabel}`;
}

/**
 * The checkout's "Pay with" picker, drawn the way the widget draws it: a
 * combobox that keeps focus while the arrow keys move through its options.
 */
export function PayWithSelect({ payouts, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listId = useId();
  const valueId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const selectedIndex = Math.max(
    0,
    payouts.findIndex((payout) => payout.id === selected.id),
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const show = () => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const payout = payouts[index];
    if (payout !== undefined) {
      onSelect(payout.id);
    }
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + step + payouts.length) % payouts.length);
      return;
    }
    if ((event.key === 'Home' || event.key === 'End') && open) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : payouts.length - 1);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div ref={root} className="relative">
      <p id={labelId} className="text-12 text-text-2 mt-14">
        Pay with
      </p>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={`rounded-12 bg-surface-2 mt-6 flex w-full items-center gap-10 border px-12 py-9 text-left transition ${
          open ? 'border-indigo-400' : 'border-line-2 hover:border-text-3'
        }`}
      >
        <ChainMark chain={selected.chain} className="size-22" />
        <span id={valueId} className="text-14 flex-1 font-medium">
          {payoutText(selected)}
        </span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`text-text-3 size-16 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          className="rounded-12 border-line-2 bg-surface absolute inset-x-0 top-full z-10 mt-6 flex flex-col gap-2 border p-4 shadow-xl shadow-black/30"
        >
          {payouts.map((payout, index) => {
            const isSelected = payout.id === selected.id;
            return (
              <li
                key={payout.id}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                // Keep focus on the combobox: the press must not blur it shut first.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                onPointerEnter={() => setActive(index)}
                className={`rounded-8 text-14 flex cursor-pointer items-center gap-10 px-10 py-8 ${
                  isSelected ? 'font-semibold' : ''
                } ${index === active ? 'bg-surface-2' : ''}`}
              >
                <ChainMark chain={payout.chain} className="size-22" />
                {payoutText(payout)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
