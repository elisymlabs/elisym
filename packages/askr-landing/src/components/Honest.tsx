import { PRODUCT_NAME } from '../constants';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';
import { SectionHeading } from './SectionHeading';

const RULES = [
  'Product cards show the price from your catalog, never one the model wrote.',
  'Every price in the text is checked against your catalog and policies before the visitor sees it. A wrong one is corrected or cut.',
  'No invented products, discounts or specs. What your store has not published, it says it does not know.',
  'Instructions hidden in a product description or typed by a visitor are treated as data, not as instructions.',
];

export function Honest() {
  return (
    <section id="honest" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1200 items-center gap-48 px-16 py-80 sm:px-24 sm:py-112 lg:grid-cols-2">
        <div className="flex flex-col gap-32">
          <SectionHeading eyebrow="Only your facts" title="It does not make things up">
            {`An assistant that invents a discount costs you more than no assistant. ${PRODUCT_NAME} answers only from what your store published.`}
          </SectionHeading>
          <ul className="flex flex-col gap-16">
            {RULES.map((rule) => (
              <li key={rule} className="text-15 text-text-2 flex gap-12 leading-relaxed">
                <Icon name="check" className="text-accent-ink mt-2 size-18 shrink-0" />
                {rule}
              </li>
            ))}
          </ul>
        </div>
        <figure
          aria-label="A wrong price stopped before the visitor sees it"
          className="rounded-24 border-line-2 bg-bg flex flex-col gap-16 border p-20 sm:p-28"
        >
          <div className="flex flex-col gap-8">
            <span className="text-12 text-text-3 font-medium tracking-wide uppercase">
              The model drafts
            </span>
            <p className="rounded-16 bg-surface-2 text-14 rounded-bl-6 px-14 py-10 leading-relaxed">
              The Merino crew sweater is <span className="line-through decoration-2">$65</span>{' '}
              today.
            </p>
          </div>
          <div className="rounded-12 border-line-2 text-13 text-text-2 flex items-center gap-10 border border-dashed px-14 py-10">
            <Icon name="shield" className="text-accent-ink size-18 shrink-0" />
            $65 is not in the catalog. The answer is rewritten.
          </div>
          <div className="flex flex-col gap-8">
            <span className="text-12 text-text-3 font-medium tracking-wide uppercase">
              The visitor sees
            </span>
            <p className="rounded-16 bg-surface-2 text-14 rounded-bl-6 px-14 py-10 leading-relaxed">
              The Merino crew sweater fits what you asked for.
            </p>
            <ProductCard title="Merino crew sweater" note="Navy, sizes S to XL" price="$72.00" />
          </div>
        </figure>
      </div>
    </section>
  );
}
