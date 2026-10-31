import type { ReactNode } from 'react';
import {
  HEADER_BAR,
  HEADER_HOME_LINK,
  HEADER_NAV,
  HEADER_ROW,
  LANDING_URL,
  PRODUCT_NAME,
} from '../constants';
import { Button } from './Button';
import { ElisymLogo } from './ElisymLogo';
import { Icon } from './Icon';
import { PayCoreLogo } from './PayCoreLogo';

interface Props {
  children: ReactNode;
  /** A signed-in cloud owner: the npub, shown in the bar with Sign out. */
  owner?: { npub: string; onSignOut: () => void };
}

/**
 * The frame of the pages before a store is open, under the landing's own bar and
 * logo, with Admin after the logo and one link back to the landing. No key is
 * loaded yet, so it opens in this tab.
 */
export function AuthLayout({ children, owner }: Props) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className={HEADER_BAR}>
        <div className={HEADER_ROW}>
          <span className="flex items-center gap-10">
            <PayCoreLogo className="h-28 w-auto" />
            <span className="text-13 text-text-3 hidden items-center gap-6 sm:flex">
              by
              <ElisymLogo />
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
            {owner === undefined ? null : (
              <span className="flex min-w-0 items-center gap-12">
                <span
                  className="text-13 text-text-2 sr-only truncate font-mono sm:not-sr-only"
                  title={owner.npub}
                >
                  {`${owner.npub.slice(0, 12)}...${owner.npub.slice(-6)}`}
                </span>
                <Button onClick={owner.onSignOut} size="sm">
                  Sign out
                </Button>
              </span>
            )}
          </nav>
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-16 pt-24 pb-64 sm:pt-56">
        {children}
      </main>
    </div>
  );
}
