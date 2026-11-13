import { DOCS } from '../constants';
import { PHOTOS } from '../media';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { PageLink } from './PageLink';
import { Reveal } from './Reveal';

const SOURCES: { title: string; body: string; tags: string[] }[] = [
  {
    title: 'Your shop, connected',
    body: 'Imported on a schedule from what your shop already shows the public. No store token, no admin access to hand over.',
    tags: ['Shopify', 'WooCommerce', 'Google product feed'],
  },
  {
    title: 'The admin',
    body: 'Import a CSV or add and edit products by hand.',
    tags: ['CSV', 'Editor'],
  },
  {
    title: 'Your code or your agent',
    body: 'Publish from your backend or CI with the SDK, or let an AI agent keep the catalog with the MCP tools.',
    tags: ['SDK', 'MCP'],
  },
  {
    title: 'A PayCore store',
    body: "Already sell with PayCore? The assistant reads that store's listings as they are.",
    tags: ['PayCore'],
  },
];

export function Sources() {
  return (
    <section id="sources" className="mx-auto max-w-1360 px-12 sm:px-24">
      <div className="grid items-stretch gap-24 lg:grid-cols-2">
        <Reveal className="rounded-32 sm:rounded-40 relative min-h-360 overflow-hidden">
          <img
            src={PHOTOS.catalog.src}
            alt={PHOTOS.catalog.alt}
            width={PHOTOS.catalog.width}
            height={PHOTOS.catalog.height}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        </Reveal>
        <Reveal delay={1} className="flex flex-col gap-24 px-4 py-24 sm:px-24 lg:py-48">
          <Eyebrow>Your catalog</Eyebrow>
          <h2 className="text-48 sm:text-64 font-serif leading-[0.98]">
            Bring the catalog <em>you already have.</em>
          </h2>
          <p className="text-18 text-text-2 leading-relaxed">
            Pick one source for your products, then add the policies the assistant may quote:
            returns, shipping, warranty and FAQ.
          </p>
          <ul className="mt-8 flex flex-col">
            {SOURCES.map((source) => (
              <li key={source.title} className="border-line-2 flex flex-col gap-8 border-t py-20">
                <div className="flex flex-wrap items-baseline justify-between gap-12">
                  <h3 className="text-24 font-serif">{source.title}</h3>
                  <ul aria-label={`${source.title}: formats`} className="flex flex-wrap gap-6">
                    {source.tags.map((tag) => (
                      <li
                        key={tag}
                        className="bg-surface-2 text-12 text-text-2 rounded-full px-10 py-4"
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="text-15 text-text-2 leading-relaxed">{source.body}</p>
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
        </Reveal>
      </div>
    </section>
  );
}
