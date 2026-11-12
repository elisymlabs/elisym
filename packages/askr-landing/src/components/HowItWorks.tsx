import { ADMIN_URL, DOCS } from '../constants';
import { Icon } from './Icon';
import { PageLink } from './PageLink';
import { SectionHeading } from './SectionHeading';

const STEPS = [
  {
    title: 'Sign in with your owner key',
    body: 'Open the admin and paste an nsec, use a NIP-07 browser extension, or let the admin make a key for you. That key is your store: keep it safe.',
    code: ADMIN_URL,
    link: { href: DOCS.overview, label: 'Onboarding' },
  },
  {
    title: 'Choose the product source',
    body: "A CSV or the editor in the admin, your own catalog key, a Shopify, WooCommerce or Google feed connector, or a Pay Core store. Add the origins your site runs on and the assistant's voice.",
    code: 'CSV, SDK, MCP, Shopify, WooCommerce, Google feed, Pay Core',
    link: { href: '#sources', label: 'Product sources' },
  },
  {
    title: 'Paste the snippet',
    body: 'Add the script tag to your pages. Once your store is active on a plan, the assistant starts answering your visitors.',
    code: 'data-store="npub1..."',
    link: { href: DOCS.embed, label: 'Embed guide' },
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="border-line bg-surface border-y">
      <div className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow="How it works" title="On your site in three steps">
          No database access to grant and no plugin to install. Your store is a key you hold and a
          tag on your pages.
        </SectionHeading>
        <ol className="mt-48 grid gap-16 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="rounded-20 border-line bg-bg flex flex-col gap-14 border p-24"
            >
              <span className="rounded-12 bg-accent text-14 text-accent-text grid size-36 place-items-center font-semibold">
                {index + 1}
              </span>
              <h3 className="text-18 mt-4 font-semibold">{step.title}</h3>
              <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
              <code className="rounded-12 border-line bg-surface text-13 mt-auto border px-12 py-10 font-mono break-all">
                {step.code}
              </code>
              <PageLink
                href={step.link.href}
                className="text-14 text-accent-ink flex items-center gap-6 self-start font-medium hover:underline"
              >
                {step.link.label}
                <Icon name="arrow" className="size-16" />
              </PageLink>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
