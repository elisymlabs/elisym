import { DOCS } from '../constants';
import { CART_HOOK_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

const ORDER = [
  {
    title: 'Your hook',
    body: 'When your page defines window.Askr.onAddToCart, the button calls it with the product id, its SKU, the variant and the options the visitor picked.',
  },
  {
    title: 'Native add-to-cart',
    body: "For a Shopify or WooCommerce connector, on the shop's own site, once the visitor's pick names one variant.",
  },
  {
    title: 'The product page',
    body: 'Otherwise the card opens the product page. A sold-out product shows a label instead of a button.',
  },
];

export function AddToCart() {
  return (
    <section id="cart" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <div className="grid items-start gap-48 lg:grid-cols-2">
        <div className="flex flex-col gap-32">
          <SectionHeading eyebrow="Add to cart" title="From the answer straight into your cart">
            Each product card links to its product page. The add-to-cart button uses the first of
            these that applies.
          </SectionHeading>
          <ol className="flex flex-col gap-20">
            {ORDER.map((item, index) => (
              <li key={item.title} className="flex gap-14">
                <span className="rounded-8 border-line-2 text-13 text-accent-ink grid size-28 shrink-0 place-items-center border font-semibold">
                  {index + 1}
                </span>
                <div className="flex flex-col gap-4">
                  <h3 className="text-16 font-semibold">{item.title}</h3>
                  <p className="text-15 text-text-2 leading-relaxed">{item.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-col gap-16 lg:mt-56">
          <CodeBlock id="cart-hook" label="Your own cart" code={CART_HOOK_SNIPPET} />
          <ExternalLink
            href={DOCS.embed}
            className="text-14 text-accent-ink flex items-center gap-6 self-start font-medium hover:underline"
          >
            Add to cart in the embed guide
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </div>
      </div>
    </section>
  );
}
