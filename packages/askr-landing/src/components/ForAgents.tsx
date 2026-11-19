import { ASKR_KEY_COMMAND, DOCS, MCP_TOOLS } from '../constants';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

export function ForAgents() {
  return (
    <section id="agents" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1160 items-start gap-48 px-16 py-80 sm:px-24 sm:py-112 lg:grid-cols-2">
        <div className="flex flex-col gap-24">
          <SectionHeading eyebrow="For agents" title="Let an AI agent keep the catalog">
            Give your agent its own catalog key with the elisym CLI, then authorize the npub it
            prints in the admin. The secret stays with the agent and is never printed.
          </SectionHeading>
          <CodeBlock id="askr-key" label="Terminal" code={ASKR_KEY_COMMAND} />
          <ExternalLink
            href={DOCS.catalogFromAnAgent}
            className="text-14 text-accent-ink flex items-center gap-6 self-start font-medium hover:underline"
          >
            Catalog from an agent
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </div>
        <div className="rounded-20 border-line bg-bg min-w-0 border p-8 lg:mt-56">
          <h3 className="text-15 text-text-2 flex items-center gap-8 px-16 pt-12 pb-8 font-medium">
            <Icon name="bot" className="text-accent-ink size-18" />
            Tools in the elisym MCP server
          </h3>
          <dl className="divide-line flex flex-col divide-y">
            {MCP_TOOLS.map((tool) => (
              <div key={tool.name} className="flex flex-col gap-4 px-16 py-14">
                <dt className="text-13 text-accent-ink font-mono break-all">{tool.name}</dt>
                <dd className="text-14 text-text-2 leading-relaxed">{tool.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
