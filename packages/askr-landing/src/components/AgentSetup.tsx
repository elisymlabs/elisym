import { AGENT_PROMPT } from '../agent-prompt';
import { BUTTON } from '../buttons';
import { DOCS } from '../constants';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

/** The prompt's opening, shown; the button copies all of it. */
const PROMPT_LINES_SHOWN = 3;
const PROMPT_EXCERPT = `${AGENT_PROMPT.split('\n').slice(0, PROMPT_LINES_SHOWN).join('\n')}\n...`;

/** The same setup done by the merchant's AI coding agent, from one prompt. */
export function AgentSetup() {
  return (
    <section id="agent-setup" className="border-line-2 border-b">
      <div className="mx-auto max-w-1440 px-16 py-120 sm:px-32 sm:py-160">
        <Reveal className="flex flex-col items-start gap-16">
          <Eyebrow>With an AI agent</Eyebrow>
          <h2 className="font-serif text-[clamp(2.5rem,5vw,5rem)] leading-[0.95] tracking-[-0.02em]">
            Or let your AI agent do it
          </h2>
          <p className="text-18 text-text-2 max-w-640 leading-relaxed">
            Paste one prompt into a coding agent with a terminal: it reads your site, asks you a few
            questions once, publishes your products and policies and adds the chat. It asks which
            plan you want, starts Free on your word, and leaves a paid plan to you and us.
          </p>
        </Reveal>
        <Reveal delay={1} className="mt-40 flex max-w-900 flex-col gap-12">
          <CodeBlock
            id="agent-prompt"
            label="The prompt"
            code={PROMPT_EXCERPT}
            copy={{ text: AGENT_PROMPT, label: 'Copy prompt' }}
          />
        </Reveal>
        <div className="mt-32 flex flex-wrap items-center gap-12">
          <ExternalLink href={DOCS.agentSetup} className={BUTTON.ghost}>
            The agent setup guide
            <Icon name="arrow" className="size-18" />
          </ExternalLink>
        </div>
      </div>
    </section>
  );
}
