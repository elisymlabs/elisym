import { useState } from 'react';

interface Props {
  text: string;
  label: string;
}

/** A block of text to copy, with a copy button. */
export function CopyBlock({ text, label }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-8">
        <span className="text-13 font-medium">{label}</span>
        <button type="button" className="btn text-13" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code">{text}</pre>
    </div>
  );
}
