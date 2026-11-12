import { DOCS, PRODUCT_NAME } from '../constants';
import { embedSnippet } from '../snippets';
import { AdminLink } from './AdminLink';
import { ChatMock } from './ChatMock';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
      <div aria-hidden="true" className="hero-dots absolute inset-0 -z-10" />
      <div className="mx-auto grid max-w-1160 items-center gap-48 px-16 pt-56 pb-72 sm:px-24 sm:pt-88 sm:pb-104 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex min-w-0 flex-col items-start">
          <p className="border-line-2 bg-surface/60 text-13 text-text-2 flex items-center gap-8 rounded-full border px-12 py-6">
            <span className="bg-accent size-6 rounded-full" />
            {`${PRODUCT_NAME}: a shopping assistant, no checkout`}
          </p>
          <h1 className="text-40 sm:text-56 mt-24 max-w-720 leading-[1.05] font-semibold tracking-tight">
            A shopping assistant for your store, in{' '}
            <span className="text-accent-ink">one script tag</span>.
          </h1>
          <p className="text-18 text-text-2 mt-24 max-w-600 leading-relaxed">
            {PRODUCT_NAME} answers your visitors from your own catalog and policies, shows product
            cards with the prices you published, and sends them to the product page or your cart. It
            takes no payments and sells nothing itself.
          </p>
          <div className="mt-32 flex flex-wrap gap-12">
            <AdminLink className="rounded-12 bg-accent text-15 text-accent-text flex items-center gap-8 px-20 py-12 font-semibold transition hover:brightness-95" />
            <ExternalLink
              href={DOCS.overview}
              className="rounded-12 border-line-2 bg-surface/60 text-15 hover:bg-surface-2 flex items-center gap-8 border px-20 py-12 font-medium"
            >
              Read the docs
              <Icon name="arrow" className="size-18" />
            </ExternalLink>
          </div>
          <div className="mt-36 w-full max-w-640">
            <CodeBlock id="embed-snippet" label="Paste into your pages" code={embedSnippet()} />
          </div>
        </div>
        <ChatMock />
      </div>
    </section>
  );
}
