import { PRODUCT_NAME } from '../constants';
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

/** "Run it in our cloud": what we run, what stays the merchant's, and the way in. */
export function Cloud() {
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
        <a
          href="#pricing"
          className="text-15 text-accent-ink self-start font-semibold underline-offset-4 hover:underline"
        >
          See the plans
        </a>
      </div>
    </section>
  );
}
