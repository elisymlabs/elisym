import { ASKR_KEY_COMMAND, DOCS, MCP_TOOLS } from '../constants';
import { CART_HOOK_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

const LINK =
  'text-14 text-on-ink-accent mt-auto flex items-center gap-6 self-start font-medium hover:underline';

export function Developers() {
  return (
    <section id="developers" className="px-12 pt-48 sm:px-24 sm:pt-64">
      <div className="rounded-32 sm:rounded-40 bg-ink text-on-ink mx-auto max-w-1360 px-20 py-72 sm:px-56 sm:py-112">
        <Reveal className="flex max-w-760 flex-col gap-20">
          <Eyebrow tone="ink">For developers</Eyebrow>
          <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
            Wire it <em className="text-on-ink-accent">into your stack.</em>
          </h2>
          <p className="text-18 text-on-ink-2 leading-relaxed">
            Hand your own cart to the assistant, or let your code or an AI agent keep the catalog
            with a key you hold.
          </p>
        </Reveal>
        <Reveal delay={1} className="mt-56 grid gap-16 lg:grid-cols-2">
          <article
            id="cart"
            className="rounded-24 border-ink-line bg-ink-2 flex min-w-0 flex-col gap-16 border p-24 sm:p-28"
          >
            <h3 className="text-28 font-serif">Your cart, one hook</h3>
            <p className="text-15 text-on-ink-2 leading-relaxed">
              Define the hook and the Add to cart button calls it with the product id, its SKU, the
              variant and the options the visitor picked. Without it, Shopify and WooCommerce sites
              get native add-to-cart, and every other card opens the product page.
            </p>
            <CodeBlock id="cart-hook" label="Your own cart" code={CART_HOOK_SNIPPET} />
            <ExternalLink href={DOCS.embed} className={LINK}>
              Add to cart in the embed guide
              <Icon name="arrow" className="size-16" />
            </ExternalLink>
          </article>
          <article
            id="agents"
            className="rounded-24 border-ink-line bg-ink-2 flex min-w-0 flex-col gap-16 border p-24 sm:p-28"
          >
            <h3 className="text-28 font-serif">A catalog your agent keeps</h3>
            <p className="text-15 text-on-ink-2 leading-relaxed">
              Give an agent its own catalog key, authorize it once in the admin, and it publishes
              your products and policies through the elisym MCP server.
            </p>
            <div className="rounded-12 border-ink-line bg-ink flex items-center gap-10 border px-14 py-10">
              <span className="text-on-ink-accent text-13 font-mono">$</span>
              <code id="askr-key" className="text-13 text-on-ink font-mono break-all">
                {ASKR_KEY_COMMAND}
              </code>
            </div>
            <dl className="grid gap-12">
              {MCP_TOOLS.map((tool) => (
                <div key={tool.name} className="border-ink-line flex flex-col gap-2 border-t pt-12">
                  <dt className="text-13 text-on-ink-accent font-mono">{tool.name}</dt>
                  <dd className="text-14 text-on-ink-2">{tool.body}</dd>
                </div>
              ))}
            </dl>
            <ExternalLink href={DOCS.catalogFromAnAgent} className={LINK}>
              Catalog from an agent
              <Icon name="arrow" className="size-16" />
            </ExternalLink>
          </article>
        </Reveal>
      </div>
    </section>
  );
}
