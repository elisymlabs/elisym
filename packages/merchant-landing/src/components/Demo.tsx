import { ElisymBuy } from '@elisym/react';
import type { DemoProduct } from '../constants';
import { Snippet } from './Snippet';

interface Props {
  demo: DemoProduct | undefined;
}

export function Demo({ demo }: Props) {
  return (
    <section id="demo" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1120 gap-32 px-16 py-64 lg:grid-cols-2">
        <div className="flex flex-col gap-16">
          <h2 className="text-28 font-semibold">This is the whole integration</h2>
          <p className="text-text-2">
            The tag shows a Buy button. The checkout opens in a modal served from
            pay.elisym.network: it checks the offer, places the order and asks the buyer&apos;s
            wallet to pay you. Your page runs only a small pinned loader.
          </p>
          {demo === undefined ? (
            <p className="text-14 text-text-2">The live demo is coming soon.</p>
          ) : (
            <div className="rounded-12 border-line flex flex-wrap items-center gap-12 border p-16">
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
        <Snippet product={demo?.product} />
      </div>
    </section>
  );
}
