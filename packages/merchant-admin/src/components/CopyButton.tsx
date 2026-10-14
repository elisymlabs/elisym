import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  text: string;
  label: string;
}

export function CopyButton({ text, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : label}
      title={label}
      className="rounded-6 text-text-3 hover:bg-surface-2 hover:text-text inline-grid size-24 shrink-0 place-items-center"
    >
      <Icon name={copied ? 'check' : 'copy'} className="size-14" />
    </button>
  );
}
