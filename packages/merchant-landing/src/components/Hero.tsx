import { DOCS } from '../constants';
import { SignInLink } from './SignInLink';

export function Hero() {
  return (
    <section className="mx-auto max-w-1120 px-16 pt-48 pb-64 sm:pt-80 sm:pb-96">
      <p className="text-13 text-text-2 font-medium tracking-wide uppercase">
        Non-custodial checkout
      </p>
      <h1 className="text-40 sm:text-56 mt-16 max-w-800 leading-tight font-semibold">
        Take crypto payments with one tag.
      </h1>
      <p className="text-18 text-text-2 mt-20 max-w-640">
        Buyers pay USDC on Solana or Tempo, straight to your wallet. Your store runs on your own
        node: no platform account, nobody holds your money, and AI agents can buy from it too.
      </p>
      <div className="mt-32 flex flex-wrap gap-12">
        <a
          href="#demo"
          className="rounded-8 bg-accent text-15 text-accent-text px-20 py-12 font-medium hover:opacity-90"
        >
          Try it
        </a>
        <a
          href={DOCS.quickstart}
          className="rounded-8 border-line text-15 hover:bg-surface-2 border px-20 py-12"
        >
          Start selling
        </a>
        <SignInLink
          label="Sign in to your store"
          className="rounded-8 text-15 text-text-2 hover:text-text px-20 py-12"
        />
      </div>
    </section>
  );
}
