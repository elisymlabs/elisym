import type { ReactNode } from 'react';
import { LANDING_URL, PRODUCT_NAME } from '../constants';
import { ElisymLogo } from './ElisymLogo';
import { Icon } from './Icon';
import { LogoMark } from './LogoMark';

interface Props {
  children: ReactNode;
}

/** The frame of the pages before a store is open. */
export function AuthLayout({ children }: Props) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-1200 items-center justify-between gap-16 px-16 py-16 sm:px-24">
        <span className="flex items-center gap-10">
          <LogoMark className="size-28" />
          <span className="text-16 font-semibold tracking-tight">{PRODUCT_NAME}</span>
          <span className="text-13 text-text-3 hidden items-center gap-6 sm:flex">
            by
            <ElisymLogo />
          </span>
          <span className="rounded-6 bg-surface-2 text-12 text-text-2 px-8 py-2 font-medium">
            Admin
          </span>
        </span>
        <a
          href={LANDING_URL}
          rel="noopener noreferrer"
          className="text-14 text-text-2 hover:text-text flex items-center gap-6"
        >
          {`About ${PRODUCT_NAME}`}
          <Icon name="external" className="size-14" />
        </a>
      </header>
      <main className="flex flex-1 items-start justify-center px-16 pt-24 pb-64 sm:items-center sm:pt-0">
        {children}
      </main>
    </div>
  );
}
