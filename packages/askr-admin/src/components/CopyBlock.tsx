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
    <div className="code-frame">
      <header>
        <span className="text-12 text-text-2 font-medium">{label}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={`${copied ? 'Copied' : 'Copy'}: ${label}`}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre>{text}</pre>
    </div>
  );
}
