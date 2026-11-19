import { PRODUCT_NAME } from '../constants';
import { PRODUCTS } from '../media';
import { LISTING_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';
import { WidgetCard } from './WidgetCard';
import { WidgetLauncher } from './WidgetLauncher';

const AGENT_POINTS = [
  'No scraping and no API key: listings are open events on a public network.',
  'Signed by your store, so an agent can check where each product came from.',
  'The same prices the widget shows, straight from your catalog.',
];

export function ForAgents() {
  return (
    <section id="ai-ready" className="mx-auto max-w-1440 px-8 pb-120 sm:px-16 sm:pb-200">
      <Reveal className="mx-auto flex max-w-880 flex-col items-center gap-20 px-4 text-center">
        <Eyebrow>Ready for AI agents</Eyebrow>
        <h2 className="font-serif text-[clamp(3rem,7vw,7rem)] leading-[0.9] tracking-[-0.03em]">
          For shoppers, <em>and for their agents.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-680 leading-relaxed">
          {`Some shoppers already send an AI agent to shop for them. With ${PRODUCT_NAME}, your catalog is also published as open, signed listings, so those agents can find and read your products directly. No scraping, and no extra work for you.`}
        </p>
      </Reveal>
      <Reveal delay={1} className="mt-56 grid gap-16 lg:grid-cols-2">
        <article className="rounded-32 border-line bg-surface flex flex-col gap-20 border p-24 sm:p-32">
          <div className="flex items-center gap-12">
            <WidgetLauncher className="origin-left scale-90" />
            <h3 className="text-28 font-serif">People use the widget</h3>
          </div>
          <p className="text-15 text-text-2 leading-relaxed">
            A chat in the corner of every page: it answers, recommends and compares, then sends the
            visitor to the product page or your cart.
          </p>
          <div className="bg-surface-2 rounded-24 mt-auto flex justify-center p-16 sm:p-24">
            <div className="wgt wgt-panel w-full max-w-380">
              <div className="wgt-log">
                <p className="wgt-mine">Which headphones last longest on a charge?</p>
                <p className="wgt-theirs">
                  The Pulse Pro lasts 40 hours on a charge, the Aria 32. Both carry a 2-year
                  warranty.
                </p>
                <div className="wgt-cards">
                  <WidgetCard product={PRODUCTS.headphonesBlack} reason="Longest battery, 40 h" />
                  <WidgetCard product={PRODUCTS.headphonesSand} reason="Lighter, 32 h battery" />
                </div>
              </div>
            </div>
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
