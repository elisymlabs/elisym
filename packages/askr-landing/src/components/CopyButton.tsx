import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  text: string;
  label?: string;
  className?: string;
}

const PLAIN =
  'rounded-8 border-ink-line text-13 text-on-ink-2 hover:text-on-ink hover:bg-ink-2 border px-10 py-6';

export function CopyButton({ text, label = 'Copy', className = PLAIN }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // The browser refused (no permission, an insecure page): say so, the text is still there.
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`flex items-center gap-6 font-medium ${className}`}
    >
      {state === 'copied' && <Icon name="check" className="size-14" />}
      {{ idle: label, copied: 'Copied', failed: 'Copy failed' }[state]}
    </button>
  );
}
