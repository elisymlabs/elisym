import { DOCS } from '../constants';
import { CART_HOOK_SNIPPET } from '../snippets';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

export function Developers() {
  return (
    <section id="developers" className="px-8 pt-48 sm:px-16 sm:pt-64">
      <div
        id="cart"
        className="rounded-32 sm:rounded-40 bg-ink text-on-ink mx-auto grid max-w-1440 items-center gap-48 px-20 py-72 sm:px-64 sm:py-112 lg:grid-cols-2"
      >
        <Reveal className="flex flex-col gap-20">
          <Eyebrow tone="ink">For developers</Eyebrow>
          <h2 className="font-serif text-[clamp(3rem,6vw,6rem)] leading-[0.9] tracking-[-0.03em]">
            Your cart, <em className="text-on-ink-2">one hook.</em>
          </h2>
          <p className="text-18 text-on-ink-2 max-w-520 leading-relaxed">
            Define the hook and the Add to cart button calls it with the product id, its SKU, the
            variant and the options the visitor picked. Without it, Shopify and WooCommerce sites
            get native add-to-cart, and every other card opens the product page.
          </p>
          <ExternalLink
            href={DOCS.embed}
            className="text-14 text-on-ink flex items-center gap-6 self-start font-medium hover:underline"
          >
            Add to cart in the embed guide
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </Reveal>
        <Reveal delay={1} className="min-w-0">
          <CodeBlock id="cart-hook" label="Your own cart" code={CART_HOOK_SNIPPET} />
        </Reveal>
      </div>
    </section>
  );
}
