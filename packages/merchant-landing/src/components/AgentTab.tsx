import { AGENT_DOCS_URL, AGENT_PROMPT, INIT_COMMAND } from '../constants';
import { Icon } from './Icon';

/** What an agent's run looks like, drawn: the commands are the quickstart's own. */
export const AGENT_RUN: { mark: string; tone: string; text: string }[] = [
  { mark: '→', tone: 'text-text-3', text: 'Reading docs.elisym.network/commerce/quickstart.md' },
  {
    mark: '?',
    tone: 'text-accent-ink',
    text: 'Your store name, wallets, RPC URL and products?',
  },
  { mark: '$', tone: 'text-text-3', text: INIT_COMMAND },
  { mark: '$', tone: 'text-text-3', text: 'npx @elisym/merchant-node setup' },
  { mark: ' ', tone: 'text-text-3', text: 'product pro-plan on sale published naddr1...' },
  { mark: '$', tone: 'text-text-3', text: 'npx @elisym/merchant-node run' },
  { mark: '✓', tone: 'text-accent-ink', text: 'Added <elisym-buy> to index.html' },
];

/** The prompt that hands the whole setup to a coding agent, and a drawing of the run it starts. */
export function AgentTab() {
  const [before, after = ''] = AGENT_PROMPT.split(AGENT_DOCS_URL);
  return (
    <div className="flex flex-col">
      <div className="flex gap-12 p-20">
        <span className="rounded-8 bg-accent-soft text-accent-ink grid size-28 shrink-0 place-items-center">
          <Icon name="bot" className="size-16" />
        </span>
        <p id="agent-prompt" className="text-14 text-text leading-relaxed">
          {before}
          <a
            href={AGENT_DOCS_URL}
            rel="noopener noreferrer"
            className="text-accent-ink break-all underline decoration-current/40 underline-offset-2"
          >
            {AGENT_DOCS_URL}
          </a>
          {after}
        </p>
      </div>
      <div aria-hidden="true" className="border-line bg-bg/60 border-t px-20 py-16">
        <p className="text-11 text-text-3 mb-8 font-semibold tracking-wide uppercase">
          Your agent runs
        </p>
        <ul className="text-12 flex flex-col gap-4 font-mono leading-relaxed">
          {AGENT_RUN.map((line) => (
            <li key={line.text} className="flex gap-10">
              <span className={`w-10 shrink-0 ${line.tone}`}>{line.mark}</span>
              <span className="text-text-2 min-w-0 truncate">{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
