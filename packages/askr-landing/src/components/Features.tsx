import type { ReactNode } from 'react';
import { PRODUCTS } from '../media';
import { Eyebrow } from './Eyebrow';
import { Reveal } from './Reveal';
import { WidgetCard } from './WidgetCard';

/** Each card stops a little lower than the one before, so the stack shows its edges. */
const STICKY_TOPS = ['top-96', 'top-116', 'top-136', 'top-156'];

const COMPARED = [PRODUCTS.headphonesSand, PRODUCTS.headphonesBlack] as const;

const COMPARE_ROWS = [
  ['Battery', '32 h', '40 h'],
  ['Weight', '250 g', '290 g'],
  ['Warranty', '2 years', '2 years'],
];

interface Feature {
  title: string;
  body: string;
  scene: ReactNode;
}

const FEATURES: Feature[] = [
  {
    title: 'Answers like your best salesperson',
    body: 'Shipping, returns, warranty, sizes, materials: it quotes the policies and listings you published, in your voice.',
    scene: (
      <>
        <p className="wgt-mine">Does the warranty cover a cracked case?</p>
        <p className="wgt-theirs">
          The 2-year warranty covers defects. A cracked case is accidental damage, which it does not
          cover.
        </p>
      </>
    ),
  },
  {
    title: 'Finds the right product',
    body: 'A visitor says what they need and what they want to spend. It searches your catalog and shows what fits.',
    scene: (
      <>
        <p className="wgt-mine">Earbuds for running, under $100</p>
        <p className="wgt-theirs">
          These are rated IPX5 for sweat and rain, and under your budget.
        </p>
        <div className="wgt-cards">
          <WidgetCard product={PRODUCTS.earbuds} reason="White, IPX5" />
        </div>
      </>
    ),
  },
  {
    title: 'Compares side by side',
    body: 'Two headphones or five laptops, row by row, with the one it recommends and why. Prices come straight from your catalog.',
    scene: (
      <>
        <p className="wgt-mine">Compare them</p>
        <p className="wgt-theirs">For long flights, the Pulse Pro: 8 more hours on a charge.</p>
        <table className="wgt-table">
          <thead>
            <tr>
              <th />
              {COMPARED.map((product) => (
                <th key={product.title}>{product.title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Price</th>
              {COMPARED.map((product) => (
                <td key={product.title}>{product.price}</td>
              ))}
            </tr>
            {COMPARE_ROWS.map(([label, first, second]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{first}</td>
                <td>{second}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    ),
  },
  {
    title: 'Sends buyers to your cart',
    body: 'Every card opens the product page. With your cart hook, or on Shopify and WooCommerce, it adds the pick to your cart.',
    scene: (
      <>
        <p className="wgt-mine">I also need a charger for them</p>
        <div className="wgt-cards">
          <WidgetCard product={PRODUCTS.charger} reason="65 W, with a 2 m cable" added />
        </div>
      </>
    ),
  },
];

/** What it does, one card at a time: each one stops near the top and the next slides over it. */
export function Features() {
  return (
    <section id="features" className="mx-auto max-w-1440 px-8 pb-120 sm:px-16 sm:pb-200">
      <Reveal className="flex flex-col gap-20 px-8 sm:px-16">
        <Eyebrow>What it does</Eyebrow>
        <h2 className="max-w-1000 font-serif text-[clamp(2.75rem,6vw,6.5rem)] leading-[0.95] tracking-[-0.025em]">
          The help a great shop assistant gives, <em className="text-text-3">on every page.</em>
        </h2>
      </Reveal>
      <ol className="mt-56 flex flex-col gap-24 sm:mt-80">
        {FEATURES.map((feature, index) => (
          <li
            key={feature.title}
            className={`rounded-32 sm:rounded-40 border-line bg-surface sticky grid ${STICKY_TOPS[index] ?? 'top-96'} min-h-[min(640px,82vh)] gap-32 overflow-hidden border p-24 shadow-[0_-24px_60px_-40px_rgb(18_19_22/0.35)] sm:p-48 lg:grid-cols-2 lg:p-64`}
          >
            <div className="flex flex-col gap-20">
              <span className="text-text-3 font-mono text-[13px]">{`0${index + 1} / 0${FEATURES.length}`}</span>
              <h3 className="font-serif text-[clamp(2.25rem,4vw,4.25rem)] leading-[0.98] tracking-[-0.02em]">
                {feature.title}
              </h3>
              <p className="text-18 text-text-2 max-w-460 leading-relaxed">{feature.body}</p>
              <span
                aria-hidden="true"
                className="text-line-2 mt-auto hidden font-serif text-[clamp(8rem,14vw,14rem)] leading-[0.75] tracking-[-0.04em] lg:block"
              >
                {`0${index + 1}`}
              </span>
            </div>
            <div className="bg-surface-2 rounded-24 flex items-center justify-center p-16 sm:p-40">
              <div className="wgt wgt-panel w-full max-w-380">
                <div className="wgt-log">{feature.scene}</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
