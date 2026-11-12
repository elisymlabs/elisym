import { DOCS, PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { PageLink } from './PageLink';
import { SectionHeading } from './SectionHeading';

const SOURCES: { icon: IconName; title: string; body: string; tags: string[] }[] = [
  {
    icon: 'table',
    title: 'The admin',
    body: "Import a CSV or edit products in the admin. The server signs them with your store's catalog key.",
    tags: ['CSV', 'Editor'],
  },
  {
    icon: 'key',
    title: 'Your own catalog key',
    body: 'Publish from your backend or CI with the @elisym/askr SDK, or let an AI agent keep the catalog with the MCP tools.',
    tags: ['SDK', 'MCP'],
  },
  {
    icon: 'plug',
    title: 'A connector',
    body: "Imported on a schedule from your shop's public endpoints only. No store token, no admin access to hand over.",
    tags: ['Shopify', 'WooCommerce', 'Google product feed'],
  },
  {
    icon: 'store',
    title: 'A Pay Core store',
    body: "An existing Pay Core store's listings, read as they are. Give each product a url so its card links to the product page.",
    tags: ['Pay Core'],
  },
];

export function Sources() {
  return (
    <section id="sources" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading eyebrow="Product sources" title="Bring the catalog you already have">
        {`A store reads its products from one source, chosen in the admin. ${PRODUCT_NAME} answers from that catalog and from the policies you publish: returns, shipping, warranty and FAQ.`}
      </SectionHeading>
      <ul className="mt-48 grid gap-16 sm:grid-cols-2">
        {SOURCES.map((source) => (
          <li
            key={source.title}
            className="rounded-20 border-line bg-surface hover:border-line-2 flex flex-col gap-16 border p-24 transition"
          >
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 place-items-center">
              <Icon name={source.icon} className="size-22" />
            </span>
            <div className="flex flex-col gap-6">
              <h3 className="text-18 font-semibold">{source.title}</h3>
              <p className="text-15 text-text-2 leading-relaxed">{source.body}</p>
            </div>
            <ul aria-label={`${source.title}: formats`} className="mt-auto flex flex-wrap gap-6">
              {source.tags.map((tag) => (
                <li
                  key={tag}
                  className="border-line-2 text-12 text-text-2 rounded-full border px-10 py-4"
                >
                  {tag}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <PageLink
        href={DOCS.overview}
        className="text-14 text-accent-ink mt-24 inline-flex items-center gap-6 font-medium hover:underline"
      >
        Product sources in the docs
        <Icon name="arrow" className="size-16" />
      </PageLink>
    </section>
  );
}
