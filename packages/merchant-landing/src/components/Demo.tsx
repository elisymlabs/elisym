import { ElisymBuy } from '@elisym/react';
import { useState } from 'react';
import { DOCS, type DemoProduct } from '../constants';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';
import { Snippet, type SnippetTab } from './Snippet';

interface Props {
  demo: DemoProduct | undefined;
}

const POINTS = [
  'The loader is pinned by an integrity hash',
  'No API key or secret on your page',
  'The buyer never leaves your site',
];

export function Demo({ demo }: Props) {
  const [tab, setTab] = useState<SnippetTab>('HTML');
  const showAgent = () => {
    setTab('AI agent');
    document
      .getElementById('snippet-card')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  return (
    <section id="demo" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <div className="grid items-start gap-48 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col gap-24">
          <SectionHeading eyebrow="Integration" title="This is the whole integration">
            One tag per product renders a Buy button. The checkout opens in a modal: it reads your
            live offer, places the order and asks the buyer&apos;s wallet to pay you.
          </SectionHeading>
          <ul className="flex flex-col gap-10">
            {POINTS.map((point) => (
              <li key={point} className="text-15 flex items-center gap-10">
                <span className="bg-accent-soft text-accent-ink grid size-22 shrink-0 place-items-center rounded-full">
                  <Icon name="check" className="size-14" />
                </span>
                {point}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={showAgent}
            className="rounded-16 border-line bg-surface hover:border-line-2 flex items-center gap-14 border p-16 text-left transition"
          >
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-40 shrink-0 place-items-center">
              <Icon name="bot" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-15 block font-semibold">Or let your AI agent do it</span>
              <span className="text-13 text-text-2 block">
                One prompt: it reads the docs, sets up your store and adds the tag.
              </span>
            </span>
            <Icon name="arrow" className="text-text-2 size-18 shrink-0" />
          </button>
          {demo === undefined ? (
            <a
              href={DOCS.widget}
              className="text-15 text-accent-ink flex items-center gap-6 font-medium hover:underline"
            >
              Read the widget guide
              <Icon name="arrow" className="size-16" />
            </a>
          ) : (
            <div className="rounded-16 border-line bg-surface flex flex-wrap items-center gap-16 border p-16">
              <ElisymBuy
                product={demo.product}
                network={demo.network}
                theme="auto"
                label="Buy demo"
              />
              <span className="text-14 text-text-2">
                {`A real ${demo.network} purchase: ${demo.price}, paid from your wallet.`}
              </span>
            </div>
          )}
        </div>
        <Snippet product={demo?.product} tab={tab} onTab={setTab} />
      </div>
    </section>
  );
}
