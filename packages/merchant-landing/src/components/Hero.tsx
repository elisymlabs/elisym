import { DOCS, PRODUCT_NAME } from '../constants';
import { CheckoutMock } from './CheckoutMock';
import { Icon } from './Icon';

const PROOF = ['Non-custodial', 'Open source', 'No platform account'];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
      <div aria-hidden="true" className="hero-grid absolute inset-0 -z-10" />
      <div className="mx-auto grid max-w-1160 items-center gap-48 px-16 pt-56 pb-72 sm:px-24 sm:pt-88 sm:pb-104 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col items-start">
          <p className="border-line-2 bg-surface/60 text-13 text-text-2 flex items-center gap-8 rounded-full border px-12 py-6">
            <span className="bg-accent size-6 rounded-full" />
            {`${PRODUCT_NAME}: stablecoin checkout on four networks`}
          </p>
          <h1 className="text-40 sm:text-60 mt-24 max-w-720 leading-[1.05] font-semibold tracking-tight">
            Accept stablecoin payments with <span className="text-accent-ink">one tag</span>.
          </h1>
          <p className="text-18 text-text-2 mt-24 max-w-600 leading-relaxed">
            Add a Buy button to any page. Buyers pay in stablecoins straight to your wallet, your
            own node confirms every payment on chain, and AI agents can buy from you too.
          </p>
          <div className="mt-36 flex flex-wrap gap-12">
            <a
              href={DOCS.quickstart}
              className="rounded-12 bg-accent text-15 text-accent-text flex items-center gap-8 px-20 py-12 font-semibold transition hover:brightness-95"
            >
              Start selling
              <Icon name="arrow" className="size-18" />
            </a>
            <a
              href="#demo"
              className="rounded-12 border-line-2 bg-surface/60 text-15 hover:bg-surface-2 border px-20 py-12 font-medium"
            >
              See the integration
            </a>
          </div>
          <ul className="text-14 text-text-2 mt-32 flex flex-wrap gap-x-20 gap-y-8">
            {PROOF.map((item) => (
              <li key={item} className="flex items-center gap-6">
                <Icon name="check" className="text-accent-ink size-16" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <CheckoutMock />
      </div>
    </section>
  );
}
