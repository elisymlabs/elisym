import { useState } from 'react';
import { Button } from './Button';

/** What the copy said, by its outcome. */
const SAID = {
  no: '',
  yes: 'Copied',
  failed: 'Copy failed: select it and copy by hand',
} as const;

interface Props {
  /** What it is, read out with the copy button. */
  label: string;
  value: string;
  /** Writes text to the clipboard (the page's own, a test's double). */
  copy?: (text: string) => Promise<void>;
}

/** A value to paste somewhere else, shown whole, with a button that copies it. */
export function CopyField({
  label,
  value,
  copy = (text) => navigator.clipboard.writeText(text),
}: Props) {
  // Said of the value it was copied for: a new value starts unsaid.
  const [result, setResult] = useState<{ value: string; copied: 'yes' | 'failed' } | undefined>();
  const copied = result?.value === value ? result.copied : 'no';
  const onCopy = async () => {
    try {
      await copy(value);
      setResult({ value, copied: 'yes' });
    } catch {
      setResult({ value, copied: 'failed' });
    }
  };
  return (
    <div className="border-line bg-bg rounded-12 flex flex-col gap-8 border p-12">
      <pre className="text-13 overflow-x-auto font-mono break-all whitespace-pre-wrap">
        <code>{value}</code>
      </pre>
      <div className="flex items-center gap-8">
        <Button size="sm" aria-label={`Copy ${label}`} onClick={() => void onCopy()}>
          Copy
        </Button>
        <span role="status" className="text-13 text-text-2">
          {SAID[copied]}
        </span>
      </div>
    </div>
  );
}
