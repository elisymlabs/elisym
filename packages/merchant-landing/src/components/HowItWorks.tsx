import { DOCS, INIT_COMMAND } from '../constants';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

const STEPS = [
  {
    title: 'Start your store node',
    body: 'One command creates your store, its keys and a first product to edit. Set your prices and the wallets you are paid to: setup publishes them, run takes orders. Node.js 22.4 or Docker.',
    code: INIT_COMMAND,
    link: { href: DOCS.quickstart, label: 'Quickstart' },
  },
  {
    title: 'Add the Buy button',
    body: 'Paste one <elisym-buy> tag per product, or use the React component. The checkout opens over your page.',
    code: '<elisym-buy product="naddr1...">',
    link: { href: DOCS.widget, label: 'Widget guide' },
  },
  {
    title: 'Get paid and fulfil',
    body: 'The payment lands in your wallet and your node confirms the payment on chain. It can send your backend a signed order.paid webhook, to credit an account or ship the order.',
    code: 'order.paid -> your backend',
    link: { href: DOCS.creditAnAccount, label: 'Credit an account' },
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="border-line bg-surface border-y">
      <div className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow="How it works" title="Start selling in three steps">
          Your store is a small node you run and a tag on your page. No account to create, no
          approval to wait for.
        </SectionHeading>
        <ol className="mt-48 grid gap-16 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="rounded-20 border-line bg-bg flex flex-col gap-14 border p-24"
            >
              <span className="rounded-12 bg-accent text-14 text-accent-text grid size-36 place-items-center font-semibold">
                {index + 1}
              </span>
              <h3 className="text-18 mt-4 font-semibold">{step.title}</h3>
              <p className="text-15 text-text-2 leading-relaxed">{step.body}</p>
              <code
                title={step.code}
                className="rounded-12 border-line bg-surface text-13 mt-auto border px-12 py-10 font-mono break-all"
              >
                {step.code}
              </code>
              <a
                href={step.link.href}
                className="text-14 text-accent-ink flex items-center gap-6 font-medium hover:underline"
              >
                {step.link.label}
                <Icon name="arrow" className="size-16" />
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
