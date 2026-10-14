import type { ReactNode } from 'react';
import {
  HEADER_BAR,
  HEADER_HOME_LINK,
  HEADER_NAV,
  HEADER_ROW,
  LANDING_URL,
  PRODUCT_NAME,
} from '../constants';
import { ElisymLogo } from './ElisymLogo';
import { Icon } from './Icon';
import { LogoMark } from './LogoMark';

interface Props {
  children: ReactNode;
}

/**
 * The frame of the pages before a store is open, under the landing's own bar and
 * logo, with Admin after the logo and one link back to the landing. No key is
 * loaded yet, so it opens in this tab.
 */
export function AuthLayout({ children }: Props) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className={HEADER_BAR}>
        <div className={HEADER_ROW}>
          <span className="flex items-center gap-10">
            <LogoMark className="size-28" />
            <span className="flex items-center gap-8">
              <span className="text-16 font-semibold tracking-tight">{PRODUCT_NAME}</span>
              <span className="text-13 text-text-3 hidden items-center gap-6 sm:flex">
                by
                <ElisymLogo />
              </span>
            </span>
            <span className="rounded-6 bg-surface-2 text-12 text-text-2 px-8 py-2 font-medium">
              Admin
            </span>
          </span>
          <nav className={HEADER_NAV} aria-label={PRODUCT_NAME}>
            <a href={LANDING_URL} className={HEADER_HOME_LINK}>
              Home
              <Icon name="external" className="size-14" />
            </a>
          </nav>
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-16 pt-24 pb-64 sm:pt-56">
        {children}
      </main>
    </div>
  );
}
