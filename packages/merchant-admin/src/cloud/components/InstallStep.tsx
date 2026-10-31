import { CopyField } from '../../components/CopyField';
import type { CheckoutLoader } from '../lib/settings';
import { AGENT_RUNBOOK_URL, buyTag, loaderScript } from '../lib/snippet';

interface Props {
  storePubkey: string;
  /** The products as kept (the ones the store sells), by name. */
  products: readonly string[];
  relayHints: readonly string[];
  network: string;
  /** A partner's checkout loader; the default checkout's when undefined. */
  loader: CheckoutLoader | undefined;
}

const OPTIONS: { name: string; text: string }[] = [
  {
    name: 'theme="dark"',
    text: "the checkout's colors, light or dark (the buyer's system otherwise)",
  },
  { name: 'label="..."', text: "the button's text" },
  { name: 'display="inline"', text: 'the checkout in the page, not in a window over it' },
  { name: 'collect-email', text: "asks for the buyer's email" },
];

/**
 * What goes into the merchant's page: the loader once, one button per
 * product, the button's options, and the same for an AI agent to paste.
 */
export function InstallStep({ storePubkey, products, relayHints, network, loader }: Props) {
  const script = loaderScript(loader);
  const buttons = products.map((product) => ({
    product,
    tag: buyTag(storePubkey, product, relayHints, network, loader),
  }));
  const forAgent = [
    `Add these Buy buttons to my website, as ${AGENT_RUNBOOK_URL}.md step 9 says.`,
    'Put this script once on each page that has a button:',
    script,
    'And each button where its product is shown:',
    ...buttons.map((button) => button.tag),
  ].join('\n');
  return (
    <div className="flex flex-col gap-20">
      <section className="flex flex-col gap-8">
        <h3 className="text-15 font-semibold">1. The script, once per page</h3>
        <CopyField label="the script" value={script} />
      </section>
      <section className="flex flex-col gap-8">
        <h3 className="text-15 font-semibold">2. A button for each product</h3>
        {buttons.map((button) => (
          <div key={button.product} className="flex flex-col gap-4">
            <span className="text-13 text-text-2 font-mono">{button.product}</span>
            <CopyField label={`the ${button.product} button`} value={button.tag} />
          </div>
        ))}
        <ul className="text-13 text-text-2 flex flex-col gap-4">
          {OPTIONS.map((option) => (
            <li key={option.name}>
              <code className="font-mono">{option.name}</code>: {option.text}
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-8">
        <h3 className="text-15 font-semibold">Give this to your AI agent</h3>
        <p className="text-13 text-text-2">
          A coding agent can add the buttons for you: paste this into it. It follows{' '}
          <a
            href={AGENT_RUNBOOK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ink underline underline-offset-2"
          >
            the agent guide
          </a>
          .
        </p>
        <CopyField label="the agent prompt" value={forAgent} />
      </section>
    </div>
  );
}
