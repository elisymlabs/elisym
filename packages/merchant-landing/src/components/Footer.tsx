import { DOCS, ELISYM_URL, GITHUB_URL, PRODUCT_NAME, X_URL } from '../constants';
import { Logo } from './Logo';
import { SignInLink } from './SignInLink';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '#demo', label: 'Integration' },
      { href: '#how', label: 'How it works' },
      { href: '#faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { href: DOCS.quickstart, label: 'Quickstart' },
      { href: DOCS.widget, label: 'Widget' },
      { href: DOCS.creditAnAccount, label: 'Credit an account' },
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
      <div className="mx-auto grid max-w-1160 gap-40 px-16 py-48 sm:px-24 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-12">
          <Logo />
          <p className="text-14 text-text-2 max-w-320">
            {`${PRODUCT_NAME} is a non-custodial checkout built on the open elisym protocol.`}
          </p>
          <SignInLink
            label="Sign in to your store"
            className="text-14 text-accent-ink self-start font-medium hover:underline"
          />
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col gap-10">
            <p className="text-13 text-text-3 font-semibold tracking-wide uppercase">
              {column.title}
            </p>
            {column.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                {...(link.href.startsWith('#') ? {} : { rel: 'noopener noreferrer' })}
                className="text-14 text-text-2 hover:text-text self-start"
              >
                {link.label}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <div className="border-line border-t">
        <p className="text-13 text-text-3 mx-auto max-w-1160 px-16 py-20 sm:px-24">
          {`© ${new Date().getFullYear()} elisym labs`}
        </p>
      </div>
    </footer>
  );
}
