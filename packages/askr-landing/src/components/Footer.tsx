import { ADMIN_URL, DOCS, ELISYM_URL, GITHUB_URL, PRODUCT_NAME, X_URL } from '../constants';
import { ElisymLogo } from './ElisymLogo';
import { PageLink } from './PageLink';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '#features', label: 'What it does' },
      { href: '#trust', label: 'Trust' },
      { href: '#pricing', label: 'Pricing' },
      { href: '#faq', label: 'FAQ' },
      { href: ADMIN_URL, label: 'Admin' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { href: DOCS.overview, label: 'Overview' },
      { href: DOCS.embed, label: 'Embed the widget' },
      { href: DOCS.catalogFromAnAgent, label: 'Catalog from an agent' },
    ],
  },
  {
    title: 'elisym',
    links: [
      { href: ELISYM_URL, label: 'elisym.network' },
      { href: GITHUB_URL, label: 'GitHub' },
      { href: X_URL, label: 'X' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mx-auto max-w-1360 overflow-hidden px-16 pt-96 sm:px-24">
      <div className="grid gap-40 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <p className="text-24 max-w-360 font-serif leading-snug">
          {`${PRODUCT_NAME} is a shopping assistant for your store's site, built by elisym labs on the open elisym protocol.`}
        </p>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col gap-10">
            <h2 className="text-12 text-text-3 font-semibold tracking-[0.14em] uppercase">
              {column.title}
            </h2>
            {column.links.map((link) => (
              <PageLink
                key={link.href}
                href={link.href}
                className="text-15 text-text-2 hover:text-text self-start"
              >
                {link.label}
              </PageLink>
            ))}
          </nav>
        ))}
      </div>
      <p
        aria-hidden="true"
        className="mt-64 font-serif text-[clamp(8rem,38vw,34rem)] leading-[0.75] tracking-[-0.04em] select-none"
      >
        {PRODUCT_NAME}
      </p>
      <div className="border-line-2 text-13 text-text-3 flex flex-wrap items-center justify-between gap-12 border-t py-20">
        <span>{`© ${new Date().getFullYear()} elisym labs`}</span>
        <span className="flex items-center gap-6">
          by
          <ElisymLogo />
        </span>
      </div>
    </footer>
  );
}
