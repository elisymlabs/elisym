import { PRODUCT_NAME } from '../constants';
import { Eyebrow } from './Eyebrow';
import { PriceCheckDemo } from './PriceCheckDemo';
import { Reveal } from './Reveal';

const RULES = [
  [
    'Real prices on every card',
    'Cards carry the price from your catalog, never one the model wrote.',
  ],
  [
    'Every price checked',
    'Each price in the text is checked against your catalog and policies before the visitor sees it. A wrong one is corrected or cut.',
  ],
  [
    'No invented anything',
    'No made-up products, discounts or specs. What your store has not published, it says it does not know.',
  ],
  [
    'Not fooled by injections',
    'Instructions hidden in a product description or typed by a visitor are treated as data, not as instructions.',
  ],
];

export function Honest() {
  return (
    <section id="honest" className="px-12 sm:px-24">
      <div className="rounded-32 sm:rounded-40 bg-ink text-on-ink mx-auto grid max-w-1360 items-center gap-48 px-20 py-72 sm:px-56 sm:py-112 lg:grid-cols-[1.05fr_0.95fr]">
        <Reveal className="flex flex-col gap-24">
          <Eyebrow tone="ink">Only your facts</Eyebrow>
          <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
            It does not <em className="text-on-ink-accent">make things up.</em>
          </h2>
          <p className="text-18 text-on-ink-2 max-w-520 leading-relaxed">
            {`An assistant that invents a discount costs you more than no assistant at all. ${PRODUCT_NAME} answers only from what your store published.`}
          </p>
          <dl className="mt-8 grid gap-x-32 gap-y-24 sm:grid-cols-2">
            {RULES.map(([title, body]) => (
              <div key={title} className="border-ink-line flex flex-col gap-6 border-t pt-16">
                <dt className="text-15 font-medium">{title}</dt>
                <dd className="text-14 text-on-ink-2 leading-relaxed">{body}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={1}>
          <PriceCheckDemo />
        </Reveal>
      </div>
    </section>
  );
}
