import { type KeyboardEvent, useRef } from 'react';

interface Props<Value extends string> {
  /** What the group chooses, for assistive technology. */
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}

const STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * A few choices as a radio group, as the landing draws it: Tab reaches the chosen one only, the
 * arrow keys move and choose as they go (wrapping at the ends), the focus ring shows where the
 * keyboard is.
 */
export function Segmented<Value extends string>({ label, options, value, onChange }: Props<Value>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const current = options.findIndex((option) => option.value === value);
    const next = (current + step + options.length) % options.length;
    const option = options[next];
    if (option !== undefined) {
      onChange(option.value);
      buttons.current[next]?.focus();
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="border-line bg-surface flex rounded-full border p-3"
    >
      {options.map((option, index) => {
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
            className={`text-13 min-w-0 flex-1 rounded-full px-14 py-5 font-medium whitespace-nowrap transition-colors ${
              chosen ? 'bg-ink text-ink-text' : 'text-text-2 hover:text-text'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
