import { BUTTON } from '../buttons';
import { DOCS } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Logo } from './Logo';

export const NAV = [
  { href: '#features', label: 'Product' },
  { href: '#ai-ready', label: 'For agents' },
  { href: '#trust', label: 'Trust' },
  { href: '#start', label: 'Get started' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

export function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-12 pt-12">
      <div className="border-line/80 bg-surface/75 mx-auto flex h-60 max-w-1200 items-center justify-between gap-16 rounded-full border pr-8 pl-20 shadow-[0_8px_30px_-12px_rgb(23_21_15_/_0.18)] backdrop-blur-xl">
        <Logo />
        <nav aria-label="Main" className="text-14 flex items-center gap-2">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-text-2 hover:text-text hidden rounded-full px-12 py-8 lg:inline"
            >
              {item.label}
            </a>
          ))}
          <ExternalLink
            href={DOCS.overview}
            className="text-text-2 hover:text-text hidden rounded-full px-12 py-8 sm:inline"
          >
            Docs
          </ExternalLink>
          <AdminLink label="Sign in" className={`${BUTTON.solid} text-14! ml-6 px-18! py-10!`} />
        </nav>
      </div>
    </header>
  );
}
