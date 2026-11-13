import { BUTTON } from '../buttons';
import { DOCS, PRODUCT_NAME } from '../constants';
import { PINNED_SNIPPET, embedSnippet } from '../snippets';
import { AdminLink } from './AdminLink';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

const STEPS = [
  {
    title: 'Create your store',
    body: 'Sign in to the admin with your owner key, or let it make one for you. Set the name, language, currency, your sites and where your products come from.',
  },
  {
    title: 'Pick a plan',
    body: 'Your store goes live once it is on a plan. Until then the admin already shows everything you set up.',
  },
  {
    title: 'Paste one line',
    body: `${PRODUCT_NAME} appears in the corner of your pages. It runs in its own shadow root, so your styles stay yours.`,
  },
];

export function GetStarted() {
  return (
    <section id="start" className="bg-surface border-line-2 border-y">
      <div className="mx-auto max-w-1200 px-16 py-96 sm:px-24 sm:py-160">
        <Reveal className="flex flex-col items-start gap-16">
          <Eyebrow>Get started</Eyebrow>
          <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
            Live on your site <em>in three steps.</em>
          </h2>
        </Reveal>
        <Reveal delay={1}>
          <ol className="mt-56 grid gap-32 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="border-line-2 flex flex-col gap-12 border-t pt-24">
                <span className="text-64 text-accent-ink font-serif leading-none italic">
                  {`0${index + 1}`}
                </span>
                <h3 className="text-24 font-serif">{step.title}</h3>
                <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
        <Reveal delay={2} className="mt-56 grid gap-16 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-12">
            <CodeBlock id="embed-snippet" label="Paste into your pages" code={embedSnippet()} />
            <p className="text-14 text-text-2 leading-relaxed">
              Always the current release: fixes reach your site within minutes.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-12">
            <CodeBlock id="pinned-snippet" label="Or pin one exact version" code={PINNED_SNIPPET} />
            <p className="text-14 text-text-2 leading-relaxed">
              The pinned tag names the widget by its hash. The browser runs it only if the file
              matches, so nobody can swap the script under your page. The admin gives you the exact
              tag.
            </p>
          </div>
        </Reveal>
        <div className="mt-40 flex flex-wrap items-center gap-12">
          <AdminLink label="Create your store" className={BUTTON.solid} />
          <ExternalLink href={DOCS.embed} className={BUTTON.ghost}>
            The embed guide
            <Icon name="arrow" className="size-18" />
          </ExternalLink>
        </div>
      </div>
    </section>
  );
}
