import { DOCS } from '../constants';
import { Logo } from './Logo';
import { SignInLink } from './SignInLink';

const NAV = [
  { href: '#demo', label: 'Integration' },
  { href: '#how', label: 'How it works' },
  { href: '#faq', label: 'FAQ' },
];

export function SiteHeader() {
  return (
    <header className="border-line/60 bg-bg/80 sticky top-0 z-20 border-b backdrop-blur-md">
      <div className="mx-auto flex h-64 max-w-1160 items-center justify-between gap-16 px-16 sm:px-24">
        <Logo />
        <nav className="text-14 flex items-center gap-4">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-text-2 hover:text-text rounded-8 hidden px-12 py-8 md:inline"
            >
              {item.label}
            </a>
          ))}
          <a
            href={DOCS.quickstart}
            className="text-text-2 hover:text-text rounded-8 hidden px-12 py-8 sm:inline"
          >
            Docs
          </a>
          <SignInLink className="rounded-8 border-line-2 hover:bg-surface-2 ml-8 border px-14 py-8 font-medium" />
        </nav>
      </div>
    </header>
  );
}
