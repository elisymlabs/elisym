import { DOCS, GITHUB_URL } from '../constants';
import { Icon } from './Icon';

export function FinalCta() {
  return (
    <section className="mx-auto max-w-1160 px-16 pb-80 sm:px-24 sm:pb-112">
      <div className="rounded-24 border-line-2 bg-surface relative isolate overflow-hidden border px-24 py-56 text-center sm:px-48 sm:py-72">
        <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
        <h2 className="text-32 sm:text-40 mx-auto max-w-640 leading-tight font-semibold tracking-tight">
          Your first sale is one command away
        </h2>
        <p className="text-16 sm:text-18 text-text-2 mx-auto mt-16 max-w-520">
          Start a store node, paste the tag, and take stablecoins straight to your wallet.
        </p>
        <div className="mt-32 flex flex-wrap justify-center gap-12">
          <a
            href={DOCS.quickstart}
            className="rounded-12 bg-accent text-15 text-accent-text flex items-center gap-8 px-20 py-12 font-semibold transition hover:brightness-95"
          >
            Start selling
            <Icon name="arrow" className="size-18" />
          </a>
          <a
            href={GITHUB_URL}
            rel="noopener noreferrer"
            className="rounded-12 border-line-2 bg-bg/60 text-15 hover:bg-surface-2 border px-20 py-12 font-medium"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
