import { DOCS } from '../constants';
import { Icon, type IconName } from './Icon';
import { PageLink } from './PageLink';
import { SectionHeading } from './SectionHeading';
import { Visual } from './Visual';

const SOURCES: { icon: IconName; title: string; body: string; tags: string[] }[] = [
  {
    icon: 'plug',
    title: 'Your shop, connected',
    body: 'Imported on a schedule from what your shop already shows the public. No store token, no admin access to hand over.',
    tags: ['Shopify', 'WooCommerce', 'Google product feed'],
  },
  {
    icon: 'table',
    title: 'The admin',
    body: 'Import a CSV or add and edit products by hand.',
    tags: ['CSV', 'Editor'],
  },
  {
    icon: 'code',
    title: 'Your code or your agent',
    body: 'Publish from your backend or CI with the SDK, or let an AI agent keep the catalog with the MCP tools.',
    tags: ['SDK', 'MCP'],
  },
  {
    icon: 'store',
    title: 'A PayCore store',
    body: "Already sell with PayCore? The assistant reads that store's listings as they are.",
    tags: ['PayCore'],
  },
];

export function Sources() {
  return (
    <section id="sources" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1200 gap-48 px-16 py-80 sm:px-24 sm:py-112 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col gap-32">
          <SectionHeading eyebrow="Your catalog" title="Bring the catalog you already have">
            Pick one source for your products in the admin, then add the policies the assistant may
            quote: returns, shipping, warranty and FAQ.
          </SectionHeading>
          <div className="rounded-24 border-line relative aspect-[4/3] overflow-hidden border">
            <Visual name="catalog" className="absolute inset-0 size-full" />
          </div>
        </div>
        <div className="flex flex-col gap-16">
          <ul className="grid gap-16">
            {SOURCES.map((source) => (
              <li
                key={source.title}
                className="rounded-20 border-line bg-bg flex gap-16 border p-20 sm:p-24"
              >
                <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 shrink-0 place-items-center">
                  <Icon name={source.icon} className="size-22" />
                </span>
                <div className="flex min-w-0 flex-col gap-8">
                  <h3 className="text-18 font-semibold">{source.title}</h3>
                  <p className="text-15 text-text-2 leading-relaxed">{source.body}</p>
                  <ul aria-label={`${source.title}: formats`} className="flex flex-wrap gap-6">
                    {source.tags.map((tag) => (
                      <li
                        key={tag}
                        className="border-line-2 text-12 text-text-2 rounded-full border px-10 py-4"
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
          <PageLink
            href={DOCS.overview}
            className="text-14 text-accent-ink inline-flex items-center gap-6 self-start font-medium hover:underline"
          >
            Product sources in the docs
            <Icon name="arrow" className="size-16" />
          </PageLink>
        </div>
      </div>
    </section>
  );
}
