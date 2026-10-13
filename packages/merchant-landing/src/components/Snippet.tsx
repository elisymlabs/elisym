import { useState } from 'react';
import { htmlSnippet, reactSnippet } from '../snippets';
import { CopyButton } from './CopyButton';

interface Props {
  product?: string;
}

const TABS = ['HTML', 'React'] as const;

export function Snippet({ product }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('HTML');
  const code = tab === 'HTML' ? htmlSnippet(product) : reactSnippet(product);
  return (
    <div className="rounded-12 border-line bg-bg min-w-0 overflow-hidden border">
      <div className="border-line flex items-center justify-between border-b px-12 py-8">
        <div role="tablist" className="flex gap-4">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={`rounded-8 text-13 px-10 py-4 ${tab === name ? 'bg-surface-2 text-text' : 'text-text-2 hover:text-text'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <CopyButton text={code} />
      </div>
      <pre id="snippet" className="text-13 overflow-x-auto p-16 font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
