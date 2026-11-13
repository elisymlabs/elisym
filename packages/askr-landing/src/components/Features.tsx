import { PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'chat',
    title: 'Answers like your best salesperson',
    body: 'Shipping, returns, warranty, sizes, materials: it answers from the policies and listings you published, in your voice and by your instructions.',
  },
  {
    icon: 'sliders',
    title: 'Finds the right product',
    body: 'A visitor says what they need and what they want to spend. It searches your catalog and shows the products that fit, with the reason each one does.',
  },
  {
    icon: 'compare',
    title: 'Compares side by side',
    body: 'Two jackets or five headphones: it lays them out row by row, and the price row comes straight from your catalog.',
  },
  {
    icon: 'cart',
    title: 'Sends buyers to your cart',
    body: "Every card opens the product page. With your cart hook, or on a Shopify or WooCommerce site, it adds the visitor's pick to your own cart.",
  },
];

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading eyebrow="What it does" title="The help a good shop assistant gives">
        {`${PRODUCT_NAME} sits in the corner of every page and turns "I'm just looking" into "this one".`}
      </SectionHeading>
      <ul className="mt-48 grid gap-16 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className="rounded-24 border-line bg-surface hover:border-line-2 flex flex-col gap-16 border p-28 transition"
          >
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 place-items-center">
              <Icon name={feature.icon} className="size-22" />
            </span>
            <h3 className="text-20 font-semibold">{feature.title}</h3>
            <p className="text-15 text-text-2 leading-relaxed">{feature.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
