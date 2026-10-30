import { CLOUD_TIERS, CONTACT_URL, type CloudTier, cloudStartUrl } from '../constants';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

/** A limit as a plan card states it: its display string, or the number. */
function productsLine(tier: CloudTier): string {
  return tier.display.products === undefined
    ? `Up to ${tier.limits.products.toLocaleString('en-US')} products`
    : `${tier.display.products} on products`;
}

function ordersLine(tier: CloudTier): string {
  if (tier.display.ordersPerMonth !== undefined) {
    return `${tier.display.ordersPerMonth} on orders`;
  }
  return tier.limits.ordersPerMonth === undefined
    ? 'No cap on orders'
    : `${tier.limits.ordersPerMonth.toLocaleString('en-US')} paid orders a month included`;
}

interface Props {
  /** The plans shown (the default list; tests pass their own). */
  tiers?: CloudTier[];
}

/** The cloud plans: price, limits and what each includes, each starting in the console or with us. */
export function Pricing({ tiers = CLOUD_TIERS }: Props) {
  return (
    <section id="pricing">
      <div className="mx-auto flex max-w-1160 flex-col gap-48 px-16 pt-40 pb-80 sm:px-24 sm:pt-56 sm:pb-112">
        <SectionHeading eyebrow="Pricing" title="One monthly price, every network">
          Every plan takes payments on Solana, Base, Arbitrum, Ethereum and Tempo, straight to your
          own wallets. Paste one script and a button; we run the rest.
        </SectionHeading>
        <ul aria-label="Plans" className="grid gap-16 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <li
              key={tier.id}
              data-tier={tier.id}
              className={`rounded-20 bg-bg flex flex-col gap-14 border p-24 ${
                tier.highlighted === true ? 'border-accent-ink' : 'border-line'
              }`}
            >
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-8">
                  <h3 className="text-18 font-semibold">{tier.name}</h3>
                  {tier.highlighted === true ? (
                    <span className="rounded-6 bg-accent-soft text-12 text-accent-ink px-8 py-2 font-semibold">
                      Recommended
                    </span>
                  ) : null}
                </div>
                <p className="text-14 text-text-2">{tier.audience}</p>
              </div>
              <p className="text-28 font-semibold tracking-tight">{tier.price}</p>
              <ul className="flex flex-col gap-8">
                {[productsLine(tier), ordersLine(tier), ...tier.features].map((feature) => (
                  <li key={feature} className="text-14 flex gap-8">
                    <span className="text-accent-ink mt-2 shrink-0">
                      <Icon name="check" className="size-16" />
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              {tier.selfServe ? (
                <a
                  href={cloudStartUrl(tier.id)}
                  rel="noopener noreferrer"
                  aria-label={`Start with ${tier.name}`}
                  className="rounded-12 bg-accent text-15 text-accent-text mt-auto px-20 py-12 text-center font-semibold transition hover:brightness-95"
                >
                  Start
                </a>
              ) : (
                <a
                  href={CONTACT_URL}
                  rel="noopener noreferrer"
                  aria-label={`Contact us about ${tier.name}`}
                  className="rounded-12 border-line-2 text-15 hover:bg-surface-2 mt-auto border px-20 py-12 text-center font-semibold"
                >
                  Contact us
                </a>
              )}
            </li>
          ))}
        </ul>
        <p className="text-14 text-text-2">
          Prices in US dollars. Self-serve plans are billed monthly by card or stablecoins. Buyers
          always pay straight to your wallets.
        </p>
      </div>
    </section>
  );
}
