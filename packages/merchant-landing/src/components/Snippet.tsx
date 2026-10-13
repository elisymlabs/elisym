import { AGENT_PROMPT } from '../constants';
import { htmlSnippet, reactSnippet } from '../snippets';
import { AgentTab } from './AgentTab';
import { CopyButton } from './CopyButton';

export const SNIPPET_TABS = ['HTML', 'React', 'AI agent'] as const;

export type SnippetTab = (typeof SNIPPET_TABS)[number];

const TAB_IDS: Record<SnippetTab, string> = {
  HTML: 'snippet-tab-html',
  React: 'snippet-tab-react',
  'AI agent': 'snippet-tab-agent',
};

interface Props {
  product?: string;
  tab: SnippetTab;
  onTab: (tab: SnippetTab) => void;
}

/** What the Copy button copies on each tab: the code, or the agent's prompt. */
export function copyText(tab: SnippetTab, product: string | undefined): string {
  if (tab === 'HTML') {
    return htmlSnippet(product);
  }
  if (tab === 'React') {
    return reactSnippet(product);
  }
  return AGENT_PROMPT;
}

/** The tab a key moves to from `index`, or undefined for a key that moves nothing. */
function tabForKey(key: string, index: number): SnippetTab | undefined {
  const last = SNIPPET_TABS.length - 1;
  const target: Record<string, number> = {
    ArrowRight: index === last ? 0 : index + 1,
    ArrowLeft: index === 0 ? last : index - 1,
    Home: 0,
    End: last,
  };
  const next = target[key];
  return next === undefined ? undefined : SNIPPET_TABS[next];
}

export function Snippet({ product, tab, onTab }: Props) {
  const text = copyText(tab, product);
  return (
    <div
      id="snippet-card"
      className="rounded-20 border-line-2 bg-surface min-w-0 overflow-hidden border shadow-xl shadow-black/10"
    >
      <div className="border-line flex items-center justify-between gap-12 border-b px-12 py-10">
        <div className="flex items-center gap-12">
          <span aria-hidden="true" className="hidden gap-6 pl-4 sm:flex">
            <span className="bg-line-2 size-10 rounded-full" />
            <span className="bg-line-2 size-10 rounded-full" />
            <span className="bg-line-2 size-10 rounded-full" />
          </span>
          <div role="tablist" aria-label="How to add the checkout" className="flex gap-4">
            {SNIPPET_TABS.map((name, index) => (
              <button
                key={name}
                id={TAB_IDS[name]}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls="snippet-panel"
                tabIndex={tab === name ? 0 : -1}
                onClick={() => onTab(name)}
                onKeyDown={(event) => {
                  const next = tabForKey(event.key, index);
                  if (next !== undefined) {
                    event.preventDefault();
                    onTab(next);
                    document.getElementById(TAB_IDS[next])?.focus();
                  }
                }}
                className={`rounded-8 text-13 px-12 py-6 font-medium whitespace-nowrap ${tab === name ? 'bg-surface-2 text-text' : 'text-text-2 hover:text-text'}`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <CopyButton text={text} label={tab === 'AI agent' ? 'Copy prompt' : 'Copy'} />
      </div>
      <div id="snippet-panel" role="tabpanel" aria-labelledby={TAB_IDS[tab]}>
        {tab === 'AI agent' ? (
          <AgentTab />
        ) : (
          <pre
            id="snippet"
            className="text-13 text-text-2 overflow-x-auto p-20 font-mono leading-relaxed"
          >
            <code>{text}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
