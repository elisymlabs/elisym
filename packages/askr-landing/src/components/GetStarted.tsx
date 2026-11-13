import { DOCS, PRODUCT_NAME } from '../constants';
import { PINNED_SNIPPET } from '../snippets';
import { AdminLink } from './AdminLink';
import { CodeBlock } from './CodeBlock';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

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
    title: 'Paste the snippet',
    body: `One script tag on your pages, and ${PRODUCT_NAME} appears in the corner. It runs in its own shadow root, so your styles stay yours.`,
  },
];

export function GetStarted() {
  return (
    <section id="start" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1200 items-start gap-48 px-16 py-80 sm:px-24 sm:py-112 lg:grid-cols-2">
        <div className="flex flex-col gap-32">
          <SectionHeading eyebrow="Get started" title="Live on your site in three steps" />
          <ol className="flex flex-col gap-24">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-16">
                <span className="rounded-12 bg-accent text-15 text-accent-text grid size-36 shrink-0 place-items-center font-semibold">
                  {index + 1}
                </span>
                <div className="flex flex-col gap-6">
                  <h3 className="text-18 font-semibold">{step.title}</h3>
                  <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <AdminLink
            label="Create your store"
            className="rounded-12 bg-accent text-15 text-accent-text self-start px-20 py-12 font-semibold transition hover:brightness-95"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-16 lg:mt-72">
          <CodeBlock id="pinned-snippet" label="Or pin one exact version" code={PINNED_SNIPPET} />
          <p className="text-14 text-text-2 leading-relaxed">
            The pinned tag names the widget by its hash. The browser runs it only if the file
            matches, so nobody can swap the script under your page. The admin gives you the exact
            tag.
          </p>
          <ExternalLink
            href={DOCS.embed}
            className="text-14 text-accent-ink flex items-center gap-6 self-start font-medium hover:underline"
          >
            The embed guide
            <Icon name="arrow" className="size-16" />
          </ExternalLink>
        </div>
      </div>
    </section>
  );
}
