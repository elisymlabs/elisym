import { ADMIN_URL, DOCS, ELISYM_URL, GITHUB_URL, PRODUCT_NAME, X_URL } from '../constants';
import { PRIVACY_PATH, TERMS_PATH } from '../legal';
import { ElisymLogo } from './ElisymLogo';
import { ExternalLink } from './ExternalLink';
import { PageLink } from './PageLink';
import { Wordmark } from './Wordmark';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '#features', label: 'What it does' },
      { href: '#trust', label: 'Privacy' },
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

const LEGAL_LINKS = [
  { href: PRIVACY_PATH, label: 'Privacy policy' },
  { href: TERMS_PATH, label: 'Terms of service' },
];

interface Props {
  /** Where the section links point: '' on the landing itself, '/' on the other pages. */
  home?: string;
}

/** A link to a section of the landing, from the page it is on. */
function sectionHref(href: string, home: string): string {
  return href.startsWith('#') ? `${home}${href}` : href;
}

export function Footer({ home = '' }: Props) {
  return (
    <footer className="bg-ink text-on-ink overflow-hidden">
      <div className="mx-auto max-w-1440 px-16 pt-32 sm:px-32">
        <div className="grid gap-40 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <p className="text-24 text-on-ink-2 max-w-360 font-serif leading-snug">
            {`${PRODUCT_NAME} is a shopping assistant for your store's site, built by Elisym Labs on the open elisym protocol.`}
          </p>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title} className="flex flex-col gap-10">
              <h2 className="text-12 text-on-ink-2 font-semibold tracking-[0.14em] uppercase">
                {column.title}
              </h2>
              {column.links.map((link) => (
                <PageLink
                  key={link.href}
                  href={sectionHref(link.href, home)}
                  className="text-15 text-on-ink hover:text-on-ink-2 self-start"
                >
                  {link.label}
                </PageLink>
              ))}
            </nav>
          ))}
        </div>
        <Wordmark className="text-on-ink mt-80 w-full select-none" />
        <div className="border-ink-line text-13 text-on-ink-2 mt-24 flex flex-wrap items-center justify-between gap-12 border-t py-20">
          <span>{`© ${new Date().getFullYear()} Elisym Labs`}</span>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-20 gap-y-8">
            {LEGAL_LINKS.map((link) => (
              <PageLink key={link.href} href={link.href} className="hover:text-on-ink">
                {link.label}
              </PageLink>
            ))}
          </nav>
          <ExternalLink href={ELISYM_URL} className="hover:text-on-ink flex items-center gap-6">
            by
            <ElisymLogo onInk />
          </ExternalLink>
        </div>
      </div>
    </footer>
  );
}
