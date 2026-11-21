import { BUTTON } from '../buttons';
import { DOCS, START_LABEL } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Logo } from './Logo';

const NAV = [
  { href: '#features', label: 'How it works' },
  { href: '#trust', label: 'Privacy' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

interface Props {
  /** Where the section links point: '' on the landing itself, '/' on the other pages. */
  home?: string;
}

export function SiteHeader({ home = '' }: Props) {
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-12 pt-12">
      <div className="border-line/80 bg-surface/75 mx-auto flex h-60 max-w-1200 items-center justify-between gap-16 rounded-full border pr-8 pl-20 shadow-[0_8px_30px_-12px_rgb(23_21_15_/_0.18)] backdrop-blur-xl">
        <Logo />
        <nav aria-label="Main" className="text-14 flex items-center gap-2">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={`${home}${item.href}`}
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
          <AdminLink
            label="Sign in"
            className="text-text-2 hover:text-text hidden rounded-full px-12 py-8 sm:inline"
          />
          <AdminLink
            label={START_LABEL}
            className={`${BUTTON.solid} text-14! ml-6 px-18! py-10!`}
          />
        </nav>
      </div>
    </header>
  );
}
