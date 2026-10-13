import { useState } from 'react';

interface Props {
  text: string;
  label: string;
}

export function CopyButton({ text, label }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded-4 text-12 text-text-2 px-4 font-sans underline-offset-2 hover:underline"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
