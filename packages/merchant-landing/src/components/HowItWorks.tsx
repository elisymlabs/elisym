import { DOCS, INIT_COMMAND } from '../constants';

const STEPS = [
  {
    title: 'Run your store node',
    body: 'init makes your store and its keys; you add products, prices and the wallets you are paid to. setup publishes them, and run takes orders and confirms payments on chain.',
    code: INIT_COMMAND,
    link: { href: DOCS.quickstart, label: 'Quickstart' },
  },
  {
    title: 'Paste the tag',
    body: 'Put one <elisym-buy> per product on your page, or use the React component. The buyer never leaves your site.',
    code: '<elisym-buy product="naddr1...">',
    link: { href: DOCS.widget, label: 'The widget' },
  },
  {
    title: 'Get paid',
    body: 'USDC lands in your wallet. Your node signs a webhook for your backend, so you credit an account or ship the order.',
    code: 'order.paid -> your backend',
    link: { href: DOCS.creditAnAccount, label: 'Credit an account' },
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-1120 px-16 py-64 sm:py-96">
      <h2 className="text-28 font-semibold">Start selling in three steps</h2>
      <ol className="mt-32 grid gap-16 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="rounded-12 border-line bg-surface flex flex-col gap-12 border p-20"
          >
            <span className="text-13 text-text-2 font-mono">{`0${index + 1}`}</span>
            <h3 className="text-18 font-semibold">{step.title}</h3>
            <p className="text-15 text-text-2">{step.body}</p>
            <code className="rounded-8 bg-bg text-13 mt-auto truncate px-10 py-8 font-mono">
              {step.code}
            </code>
            <a href={step.link.href} className="text-14 underline underline-offset-2">
              {step.link.label}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
