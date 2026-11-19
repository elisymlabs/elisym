import { type KeyboardEvent, useRef } from 'react';
import { YEARLY_DISCOUNT_BPS } from '../constants';

export type Billing = 'monthly' | 'yearly';

const OPTIONS: readonly { value: Billing; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

interface Props {
  value: Billing;
  onChange: (value: Billing) => void;
}

/**
 * Monthly or yearly billing, as a radio group: Tab reaches the chosen option, the arrow keys
 * move between the two and choose as they go, the focus ring shows where the keyboard is.
 */
export function BillingSwitch({ value, onChange }: Props) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const current = OPTIONS.findIndex((option) => option.value === value);
    const next = (current + step + OPTIONS.length) % OPTIONS.length;
    const option = OPTIONS[next];
    if (option !== undefined) {
      onChange(option.value);
      buttons.current[next]?.focus();
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-12">
      <div
        role="radiogroup"
        aria-label="Billing period"
        onKeyDown={onKeyDown}
        className="border-line bg-surface flex rounded-full border p-4"
      >
        {OPTIONS.map((option, index) => {
          const chosen = option.value === value;
          return (
            <button
              key={option.value}
              ref={(button) => {
                buttons.current[index] = button;
              }}
              type="button"
              role="radio"
              aria-checked={chosen}
              tabIndex={chosen ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={`text-14 rounded-full px-18 py-8 font-medium transition ${chosen ? 'bg-ink text-on-ink' : 'text-text-2 hover:text-text'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <span className="bg-surface-2 text-13 text-text rounded-full px-12 py-6 font-medium">
        {`Save ${YEARLY_DISCOUNT_BPS / 100}% yearly`}
      </span>
    </div>
  );
}
