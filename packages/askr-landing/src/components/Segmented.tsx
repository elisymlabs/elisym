import { type KeyboardEvent, useRef } from 'react';

interface Props<Value extends string> {
  /** What the group chooses, for assistive technology. */
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
  /** Drawn on ink, inside a dark card. */
  onInk?: boolean;
}

/**
 * A few choices as a radio group: Tab reaches the chosen one, the arrow keys move and choose as
 * they go, the focus ring shows where the keyboard is.
 */
export function Segmented<Value extends string>({
  label,
  options,
  value,
  onChange,
  onInk = false,
}: Props<Value>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
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
      className={`flex rounded-full border p-4 ${onInk ? 'border-ink-line bg-ink-2' : 'border-line bg-surface'}`}
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        let look = 'text-text-2 hover:text-text';
        if (chosen) {
          look = onInk ? 'bg-on-ink text-ink' : 'bg-ink text-on-ink';
        } else if (onInk) {
          look = 'text-on-ink-2 hover:text-on-ink';
        }
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
            className={`text-14 flex-1 rounded-full px-16 py-8 font-medium transition ${look}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
