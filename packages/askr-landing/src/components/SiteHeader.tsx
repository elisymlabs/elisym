import { DOCS } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Logo } from './Logo';

export const NAV = [
  { href: '#features', label: 'Product' },
  { href: '#trust', label: 'Trust' },
  { href: '#start', label: 'Get started' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

export function SiteHeader() {
  return (
    <header className="border-line/60 bg-bg/80 sticky top-0 z-20 border-b backdrop-blur-md">
      <div className="mx-auto flex h-64 max-w-1200 items-center justify-between gap-16 px-16 sm:px-24">
        <Logo />
        <nav aria-label="Main" className="text-14 flex items-center gap-4">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-text-2 hover:text-text rounded-8 hidden px-12 py-8 lg:inline"
            >
              {item.label}
            </a>
          ))}
          <ExternalLink
            href={DOCS.overview}
            className="text-text-2 hover:text-text rounded-8 hidden px-12 py-8 sm:inline"
          >
            Docs
          </ExternalLink>
          <AdminLink
            label="Sign in"
            className="rounded-8 border-line-2 hover:bg-surface-2 ml-8 border px-14 py-8 font-medium"
          />
        </nav>
      </div>
    </header>
  );
}
