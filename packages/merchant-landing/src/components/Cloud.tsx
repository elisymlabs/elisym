import { CLOUD_AGENT_DOCS_URL, CLOUD_AGENT_PROMPT, PRODUCT_NAME } from '../constants';
import { CopyButton } from './CopyButton';
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

const STEPS: { title: string; body: string; icon: IconName }[] = [
  {
    title: 'Create your key',
    body: 'Accept the terms and the console makes your owner key in your browser. It is how you sign in.',
    icon: 'key',
  },
  {
    title: 'Pay the first month',
    body: 'By card or stablecoins. Your store is ready as soon as the payment arrives.',
    icon: 'wallet',
  },
  {
    title: 'Set up and launch',
    body: 'Name your store, add products and the wallets you are paid to, then press Launch.',
    icon: 'bolt',
  },
];

/** "Run it in our cloud": what we run, what stays the merchant's, and the way in. */
export function Cloud() {
  const [before, after = ''] = CLOUD_AGENT_PROMPT.split(CLOUD_AGENT_DOCS_URL);
  return (
    <section id="cloud">
      <div className="mx-auto flex max-w-1160 flex-col gap-48 px-16 pt-80 pb-40 sm:px-24 sm:pt-112 sm:pb-56">
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
        <ol className="rounded-20 border-line bg-surface divide-line grid divide-y border md:grid-cols-3 md:divide-x md:divide-y-0">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-12 p-24">
              <div className="flex items-center justify-between gap-12">
                <span className="text-12 text-accent-ink font-semibold tracking-wide uppercase">
                  Step {index + 1}
                </span>
                <span className="rounded-12 bg-accent-soft text-accent-ink grid size-36 place-items-center">
                  <Icon name={step.icon} className="size-18" />
                </span>
              </div>
              <h3 className="text-16 font-semibold">{step.title}</h3>
              <p className="text-14 text-text-2 leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="rounded-20 border-line bg-surface grid gap-20 border p-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-32">
          <div className="flex flex-col gap-12">
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-36 place-items-center">
              <Icon name="bot" className="size-20" />
            </span>
            <h3 className="text-18 font-semibold">Or let your AI agent set it up</h3>
            <p className="text-14 text-text-2 leading-relaxed">
              Paste this prompt into a coding agent. It follows our guide, asks you only for your
              plan, wallets and products, and hands you the button for your page.
            </p>
          </div>
          <div className="rounded-16 border-line bg-bg flex min-w-0 flex-col gap-12 border p-16">
            <p
              id="cloud-agent-prompt"
              className="text-13 text-text-2 font-mono leading-relaxed break-words"
            >
              {before}
              <a
                href={CLOUD_AGENT_DOCS_URL}
                rel="noopener noreferrer"
                className="text-accent-ink break-all underline decoration-current/40 underline-offset-2"
              >
                {CLOUD_AGENT_DOCS_URL}
              </a>
              {after}
            </p>
            <div className="flex justify-end">
              <CopyButton text={CLOUD_AGENT_PROMPT} label="Copy prompt" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
