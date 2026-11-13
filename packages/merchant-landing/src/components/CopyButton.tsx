import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  text: string;
  label?: string;
  className?: string;
}

const PLAIN =
  'rounded-8 border-line text-13 text-text-2 hover:text-text hover:bg-surface-2 border px-10 py-6';

/** The button's words after a copy; idle shows its own label. */
const SHOWN: Partial<Record<'idle' | 'copied' | 'failed', string>> = {
  copied: 'Copied',
  failed: 'Copy failed',
};

/** What a screen reader hears after a copy. */
const ANNOUNCED: Record<'idle' | 'copied' | 'failed', string> = {
  idle: '',
  copied: 'Copied to the clipboard.',
  failed: 'Could not copy: select the text and copy it yourself.',
};

export function CopyButton({ text, label = 'Copy', className = PLAIN }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // A browser that refuses the clipboard: said, so the text can be selected by hand.
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        className={`flex items-center gap-6 font-medium ${className}`}
      >
        {state === 'copied' && <Icon name="check" className="size-14" />}
        {SHOWN[state] ?? label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {ANNOUNCED[state]}
      </span>
    </>
  );
}
