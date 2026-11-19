import { BUTTON } from '../buttons';
import { DOCS, PRODUCT_NAME, START_LABEL } from '../constants';
import { embedSnippet } from '../snippets';
import { AdminLink } from './AdminLink';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

/** All a store needs to go live, in order. */
const STEPS = [
  {
    title: 'Create your store',
    body: 'Open the admin and let it make a secret key for your store. Save it: it is your store.',
  },
  {
    title: 'Add your products and your site',
    body: 'Pick where products come from (your shop, a CSV or the editor) and the address your site runs on. The assistant answers only there.',
  },
  {
    title: 'Get on a plan',
    body: 'Start on the free plan and move up as you grow. Your store goes live once it is on a plan.',
  },
  {
    title: 'Paste one line',
    body: `${PRODUCT_NAME} appears in the corner of every page that has it. It runs in its own shadow root, so your styles stay yours.`,
  },
];

/** What a store can add when it wants to, each with where it is set. */
const EXTRAS = [
  {
    title: 'Policies it can quote',
    body: 'Returns, shipping, warranty and FAQ, in your words.',
    where: 'Admin, Policies',
  },
  {
    title: 'A voice and a greeting',
    body: 'The assistant’s name, how it greets and talks, and what it should always mention.',
    where: 'Admin, Settings',
  },
  {
    title: 'Add to cart from the chat',
    body: 'Built in when your products come from Shopify or WooCommerce. On any other site, one small hook.',
    where: 'window.Askr.onAddToCart',
  },
  {
    title: 'Theme and language',
    body: 'Light or dark, and the widget’s own texts in any of its ten languages. Without them it follows the visitor’s system and your page.',
    where: 'data-theme, data-lang',
  },
  {
    title: 'Your own spot on the page',
    body: 'Put the chat element where it should go instead of the corner button.',
    where: '<askr-chat>',
  },
  {
    title: 'A catalog kept by your code',
    body: 'Publish products from your backend, or let an AI agent keep them with the MCP tools.',
    where: 'SDK, MCP',
  },
];

export function GetStarted() {
  return (
    <section id="start" className="bg-surface border-line-2 border-y">
      <div className="mx-auto max-w-1440 px-16 py-120 sm:px-32 sm:py-200">
        <Reveal className="flex flex-col items-start gap-16">
          <Eyebrow>Get started</Eyebrow>
          <h2 className="font-serif text-[clamp(3rem,7vw,7rem)] leading-[0.9] tracking-[-0.03em]">
            Live on your site <em className="text-text-3">in four steps.</em>
          </h2>
          <p className="text-18 text-text-2 max-w-640 leading-relaxed">
            This is all it takes. Everything else is optional and can wait.
          </p>
        </Reveal>
        <Reveal delay={1}>
          <ol className="mt-56 grid gap-32 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="border-text flex flex-col gap-12 border-t pt-24">
                <span className="text-text-3 font-mono text-[13px]">{`0${index + 1}`}</span>
                <h3 className="text-24 font-serif leading-tight">{step.title}</h3>
                <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
        <Reveal delay={2} className="mt-56 flex max-w-900 flex-col gap-12">
          <CodeBlock
            id="embed-snippet"
            label="The one line, for every page"
            code={embedSnippet()}
          />
          <p className="text-14 text-text-2 leading-relaxed">
            The admin gives you this line with your Store ID under Embed. Paste it before the
            closing body tag on every page that should show the chat. It always loads the current
            version, so fixes reach your site within minutes.
          </p>
        </Reveal>
        <div className="mt-40 flex flex-wrap items-center gap-12">
          <AdminLink label={START_LABEL} className={BUTTON.solid} />
          <ExternalLink href={DOCS.embed} className={BUTTON.ghost}>
            The embed guide
            <Icon name="arrow" className="size-18" />
          </ExternalLink>
        </div>

        <Reveal className="mt-120 flex flex-col gap-16">
          <h3 className="font-serif text-[clamp(2.25rem,4vw,4rem)] leading-[0.95] tracking-[-0.02em]">
            When you want more
          </h3>
          <p className="text-16 text-text-2 max-w-560 leading-relaxed">
            None of it is needed to go live. Add any of it whenever you like.
          </p>
        </Reveal>
        <Reveal delay={1}>
          <ul className="border-line-2 mt-40 grid border-t sm:grid-cols-2 lg:grid-cols-3">
            {EXTRAS.map((extra) => (
              <li
                key={extra.title}
                className="border-line-2 flex flex-col gap-10 border-b py-28 sm:pr-32"
              >
                <h4 className="text-18 font-medium">{extra.title}</h4>
                <p className="text-15 text-text-2 leading-relaxed">{extra.body}</p>
                <span className="bg-surface-2 text-text-2 mt-auto self-start rounded-full px-10 py-4 font-mono text-[12px]">
                  {extra.where}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
