import { DOCS, PRODUCT_NAME } from '../constants';
import { embedSnippet } from '../snippets';
import { AdminLink } from './AdminLink';
import { ChatDemo } from './ChatDemo';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { Visual } from './Visual';

const PROOF = ['Answers from your catalog', 'Real prices on every card', 'One script tag'];

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
      <div aria-hidden="true" className="hero-dots absolute inset-0 -z-10" />
      <div className="mx-auto grid max-w-1200 items-center gap-48 px-16 pt-56 pb-80 sm:px-24 sm:pt-88 sm:pb-112 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="flex min-w-0 flex-col items-start">
          <p className="border-line-2 bg-surface/60 text-13 text-text-2 flex items-center gap-8 rounded-full border px-12 py-6">
            <span className="bg-accent size-6 rounded-full" />
            {`${PRODUCT_NAME}: the shopping assistant for your store's site`}
          </p>
          <h1 className="text-40 sm:text-56 lg:text-72 mt-24 leading-[1.02] font-semibold tracking-tight">
            Helps every visitor buy.{' '}
            <span className="text-accent-ink">Never makes up a price.</span>
          </h1>
          <p className="text-18 text-text-2 mt-24 max-w-600 leading-relaxed">
            {`${PRODUCT_NAME} answers your visitors from your own catalog and policies, finds products for their need and budget, compares them and sends them to the product page or your cart. It takes no payments and sells nothing itself.`}
          </p>
          <div className="mt-32 flex flex-wrap gap-12">
            <AdminLink
              label="Create your store"
              className="rounded-12 bg-accent text-15 text-accent-text px-20 py-12 font-semibold transition hover:brightness-95"
            />
            <ExternalLink
              href={DOCS.overview}
              className="rounded-12 border-line-2 bg-surface/60 text-15 hover:bg-surface-2 flex items-center gap-8 border px-20 py-12 font-medium"
            >
              Read the docs
              <Icon name="arrow" className="size-18" />
            </ExternalLink>
          </div>
          <ul className="text-14 text-text-2 mt-28 flex flex-wrap gap-x-20 gap-y-8">
            {PROOF.map((item) => (
              <li key={item} className="flex items-center gap-6">
                <Icon name="check" className="text-accent-ink size-16" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-36 w-full max-w-640">
            <CodeBlock id="embed-snippet" label="Paste into your pages" code={embedSnippet()} />
          </div>
        </div>
        <div className="rounded-32 border-line relative isolate grid min-h-520 place-items-center overflow-hidden border p-16 sm:p-32">
          <Visual name="hero" className="absolute inset-0 -z-20 size-full" />
          <ChatDemo />
        </div>
      </div>
    </section>
  );
}
