import { ADMIN_URL, DOCS, ELISYM_URL, GITHUB_URL, PRODUCT_NAME, X_URL } from '../constants';
import { Logo } from './Logo';
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
    <footer className="border-line border-t">
      <div className="mx-auto grid max-w-1200 gap-40 px-16 py-48 sm:px-24 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-12">
          <Logo />
          <p className="text-14 text-text-2 max-w-320">
            {`${PRODUCT_NAME} is a shopping assistant for your store's site, built by elisym labs on the open elisym protocol.`}
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col gap-10">
            <h2 className="text-13 text-text-3 font-semibold tracking-wide uppercase">
              {column.title}
            </h2>
            {column.links.map((link) => (
              <PageLink
                key={link.href}
                href={link.href}
                className="text-14 text-text-2 hover:text-text self-start"
              >
                {link.label}
              </PageLink>
            ))}
          </nav>
        ))}
      </div>
      <div className="border-line border-t">
        <p className="text-13 text-text-3 mx-auto max-w-1200 px-16 py-20 sm:px-24">
          {`© ${new Date().getFullYear()} elisym labs`}
        </p>
      </div>
    </footer>
  );
}
