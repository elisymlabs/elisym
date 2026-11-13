import { PRODUCT_NAME } from '../constants';
import { PRODUCTS } from '../media';
import { LISTING_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';
import { Reveal } from './Reveal';

const AGENT_POINTS = [
  'No scraping and no API key: listings are open events on a public network.',
  'Signed by your store, so an agent can check where each product came from.',
  'The same prices the widget shows, straight from your catalog.',
];

export function ForAgents() {
  return (
    <section id="ai-ready" className="mx-auto max-w-1360 px-12 pb-96 sm:px-24 sm:pb-160">
      <Reveal className="mx-auto flex max-w-880 flex-col items-center gap-20 px-4 text-center">
        <Eyebrow>Ready for AI agents</Eyebrow>
        <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
          For shoppers, <em>and for their agents.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-680 leading-relaxed">
          {`People ask ${PRODUCT_NAME} in the widget on your site. AI agents shopping for someone read your products directly: your catalog is published as open, signed listings on Nostr.`}
        </p>
      </Reveal>
      <Reveal delay={1} className="mt-56 grid gap-16 lg:grid-cols-2">
        <article className="rounded-32 border-line bg-surface flex flex-col gap-20 border p-24 sm:p-32">
          <div className="flex items-center gap-12">
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 place-items-center">
              <Icon name="chat" className="size-22" />
            </span>
            <h3 className="text-28 font-serif">People use the widget</h3>
          </div>
          <p className="text-15 text-text-2 leading-relaxed">
            A chat in the corner of every page: it answers, recommends and compares, then sends the
            visitor to the product page or your cart.
          </p>
          <div className="bg-bg rounded-20 border-line mt-auto flex flex-col gap-10 border p-14">
            <p className="bg-ink text-14 text-on-ink rounded-br-6 max-w-[85%] self-end rounded-[18px] px-14 py-10">
              Which headphones last longest on a charge?
            </p>
            <p className="bg-surface-2 text-14 rounded-bl-6 max-w-[92%] self-start rounded-[18px] px-14 py-10 leading-relaxed">
              The Pulse Pro lasts 40 hours on a charge, the Aria 32. Both carry a 2-year warranty.
            </p>
            <ProductCard product={PRODUCTS.headphonesBlack} />
            <ProductCard product={PRODUCTS.headphonesSand} />
          </div>
        </article>
        <article className="rounded-32 bg-ink text-on-ink flex min-w-0 flex-col gap-20 p-24 sm:p-32">
          <div className="flex items-center gap-12">
            <span className="rounded-12 bg-ink-2 text-on-ink-accent grid size-44 place-items-center">
              <Icon name="bot" className="size-22" />
            </span>
            <h3 className="text-28 font-serif">Agents read your catalog</h3>
          </div>
          <ul className="flex flex-col gap-10">
            {AGENT_POINTS.map((point) => (
              <li key={point} className="text-15 text-on-ink-2 flex gap-10 leading-relaxed">
                <Icon name="check" className="text-on-ink-accent mt-2 size-18 shrink-0" />
                {point}
              </li>
            ))}
          </ul>
          <CodeBlock
            id="listing-snippet"
            label="A product, as an agent reads it"
            code={LISTING_SNIPPET}
          />
        </article>
      </Reveal>
    </section>
  );
}
