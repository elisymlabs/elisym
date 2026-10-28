import {
  CLOUD_TIERS,
  CONTACT_URL,
  type CloudTier,
  PRODUCT_NAME,
  cloudStartUrl,
} from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';

const WE_RUN = [
  'Your store node, online around the clock',
  'Watching the chains for your payments',
  'Signed order webhooks to your backend',
  'RPC endpoints, updates and monitoring',
];

const STAYS_YOURS: { icon: IconName; text: string }[] = [
  {
    icon: 'wallet',
    text: 'Buyers pay straight to your own wallets: the money never passes through us.',
  },
  { icon: 'key', text: 'Your owner key is made in your browser and never leaves it.' },
  { icon: 'globe', text: 'Once it is live, export your store and run it yourself any time.' },
];

const STEPS = [
  {
    title: 'Create your key',
    body: 'Accept the terms, and the console makes your owner key in your browser. Save it: it is how you sign in.',
  },
  {
    title: 'Pay the first month',
    body: 'By card or stablecoins. Your store is created as soon as the payment arrives.',
  },
  {
    title: 'Set up and launch',
    body: 'Name your store, add products and choose the wallets you are paid to (your key signs them). Usually you prove your domain with one DNS record. Then press Launch.',
  },
];

/** A self-serve tier's price once set; a Contact us tier is priced per merchant. */
function tierPrice(tier: CloudTier): string {
  if (tier.price !== undefined) {
    return tier.price;
  }
  return tier.selfServe ? 'Price at launch' : 'Custom pricing';
}

interface Props {
  /** The plans shown (the default list; tests pass their own). */
  tiers?: CloudTier[];
}

/** "Run it in our cloud": what we run, what stays the merchant's, and the way in. */
export function Cloud({ tiers = CLOUD_TIERS }: Props) {
  return (
    <section id="cloud">
      <div className="mx-auto flex max-w-1160 flex-col gap-48 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow={`${PRODUCT_NAME} in the cloud`} title="Run it in our cloud">
          Rather not run a server? We host your store node for a monthly fee. You keep your wallets
          and your key; we keep the node online.
        </SectionHeading>
        <div className="grid gap-16 lg:grid-cols-2">
          <div className="rounded-20 border-line bg-surface flex flex-col gap-16 border p-24">
            <h3 className="text-18 font-semibold">What we run</h3>
            <ul className="flex flex-col gap-10">
              {WE_RUN.map((item) => (
                <li key={item} className="text-15 flex gap-10">
                  <span className="text-accent-ink mt-2 shrink-0">
                    <Icon name="check" className="size-18" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-20 border-line bg-surface flex flex-col gap-16 border p-24">
            <h3 className="text-18 font-semibold">What stays yours</h3>
            <ul className="flex flex-col gap-10">
              {STAYS_YOURS.map((item) => (
                <li key={item.text} className="text-15 flex gap-10">
                  <span className="text-accent-ink mt-2 shrink-0">
                    <Icon name={item.icon} className="size-18" />
                  </span>
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <ol className="grid gap-16 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-14">
              <span className="rounded-12 bg-accent text-14 text-accent-text grid size-36 shrink-0 place-items-center font-semibold">
                {index + 1}
              </span>
              <div className="flex flex-col gap-6">
                <h3 className="text-16 font-semibold">{step.title}</h3>
                <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <ul aria-label="Plans" className="grid gap-16 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <li
              key={tier.id}
              data-tier={tier.id}
              className="rounded-20 border-line bg-bg flex flex-col gap-14 border p-24"
            >
              <div className="flex flex-col gap-4">
                <h3 className="text-18 font-semibold">{tier.name}</h3>
                <p className="text-14 text-text-2">{tier.audience}</p>
              </div>
              <p className="text-15 font-semibold">{tierPrice(tier)}</p>
              <ul className="flex flex-col gap-8">
                {tier.features.map((feature) => (
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
          Self-serve prices, and how many orders each plan includes a month, are announced at
          launch.
        </p>
      </div>
    </section>
  );
}
