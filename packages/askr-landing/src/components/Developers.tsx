import { ASKR_KEY_COMMAND, DOCS, MCP_TOOLS } from '../constants';
import { CART_HOOK_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

export function Developers() {
  return (
    <section id="developers" className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading eyebrow="For developers" title="Wire it into your stack">
        Hand your own cart to the assistant, or let your code or an AI agent keep the catalog with a
        key you hold.
      </SectionHeading>
      <div className="mt-48 grid gap-16 lg:grid-cols-2">
        <article
          id="cart"
          className="rounded-24 border-line bg-surface flex min-w-0 flex-col gap-16 border p-24 sm:p-28"
        >
          <h3 className="text-20 font-semibold">Your cart, one hook</h3>
          <p className="text-15 text-text-2 leading-relaxed">
            Define the hook and the Add to cart button calls it with the product id, its SKU, the
            variant and the options the visitor picked. Without it, Shopify and WooCommerce sites
            get native add-to-cart, and every other card opens the product page.
          </p>
          <CodeBlock id="cart-hook" label="Your own cart" code={CART_HOOK_SNIPPET} />
          <ExternalLink
            href={DOCS.embed}
            className="text-14 text-accent-ink mt-auto flex items-center gap-6 self-start font-medium hover:underline"
          >
            Add to cart in the embed guide
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </article>
        <article
          id="agents"
          className="rounded-24 border-line bg-surface flex min-w-0 flex-col gap-16 border p-24 sm:p-28"
        >
          <h3 className="text-20 font-semibold">A catalog your agent keeps</h3>
          <p className="text-15 text-text-2 leading-relaxed">
            Give an agent its own catalog key, authorize it once in the admin, and it publishes your
            products and policies through the elisym MCP server.
          </p>
          <div className="rounded-12 border-line-2 bg-bg flex items-center gap-10 border px-14 py-10">
            <span className="text-accent-ink text-13 font-mono">$</span>
            <code id="askr-key" className="text-13 text-text-2 font-mono break-all">
              {ASKR_KEY_COMMAND}
            </code>
          </div>
          <dl className="grid gap-10">
            {MCP_TOOLS.map((tool) => (
              <div key={tool.name} className="flex flex-col gap-2">
                <dt className="text-13 text-accent-ink font-mono">{tool.name}</dt>
                <dd className="text-14 text-text-2">{tool.body}</dd>
              </div>
            ))}
          </dl>
          <ExternalLink
            href={DOCS.catalogFromAnAgent}
            className="text-14 text-accent-ink mt-auto flex items-center gap-6 self-start font-medium hover:underline"
          >
            Catalog from an agent
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </article>
      </div>
    </section>
  );
}
