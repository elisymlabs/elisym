import { DOCS } from '../constants';
import { SignInLink } from './SignInLink';

export function SiteHeader() {
  return (
    <header className="mx-auto flex max-w-1120 items-center justify-between gap-16 px-16 py-20">
      <a href="/" className="text-16 flex items-center gap-8 font-semibold">
        <img src="/favicon.svg" alt="" className="size-24" />
        elisym checkout
      </a>
      <nav className="text-14 flex items-center gap-16">
        <a href={DOCS.quickstart} className="text-text-2 hover:text-text hidden sm:inline">
          Docs
        </a>
        <SignInLink className="rounded-8 border-line hover:bg-surface-2 border px-14 py-8" />
      </nav>
    </header>
  );
}
