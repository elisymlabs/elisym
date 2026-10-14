import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  text: string;
  label?: string;
  className?: string;
}

const PLAIN =
  'rounded-8 border-line text-13 text-text-2 hover:text-text hover:bg-surface-2 border px-10 py-6';

export function CopyButton({ text, label = 'Copy', className = PLAIN }: Props) {
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
      className={`flex items-center gap-6 font-medium ${className}`}
    >
      {copied && <Icon name="check" className="size-14" />}
      {copied ? 'Copied' : label}
    </button>
  );
}
