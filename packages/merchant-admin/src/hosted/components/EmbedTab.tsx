import { type ReactNode, useState } from 'react';
import { embedSnippet, productNaddr } from '../lib/embed';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { useProducts } from '../lib/use-products';
import { TEXT_INPUT } from '../styles';
import { CodeBlock } from './CodeBlock';
import { DomainGuide } from './DomainGuide';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

export const NOTHING_ON_SALE =
  'Put a product on sale first (Products tab): each one has its own snippet.';

/** The v3 `<elisym-buy>` snippet per product on sale, and the level A guidance (A9). */
export function EmbedTab({ session, view }: Props) {
  const { products, problem } = useProducts(session.api);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const config = view.config;
  if (config === null) {
    return <Notice tone="warn">Your store has no settings yet. Reload the page.</Notice>;
  }
  const onSale = (products ?? []).filter((product) => product.onSale);
  const selected = onSale.find((product) => product.d === chosen) ?? onSale[0];

  let snippet: ReactNode;
  if (products === undefined) {
    snippet =
      problem === undefined ? <p className="text-13 text-text-2">Loading products...</p> : null;
  } else if (selected === undefined) {
    snippet = <Notice tone="info">{NOTHING_ON_SALE}</Notice>;
  } else {
    snippet = (
      <div className="flex flex-col gap-12">
        <label className="text-14 flex flex-col gap-4">
          Product
          <select
            id="embed-product"
            className={TEXT_INPUT}
            value={selected.d}
            onChange={(event) => setChosen(event.target.value)}
          >
            {onSale.map((product) => (
              <option key={product.d} value={product.d}>
                {product.title} ({product.d})
              </option>
            ))}
          </select>
        </label>
        <CodeBlock
          id="embed-snippet"
          label="Snippet"
          text={embedSnippet(productNaddr(view.storePubkey, selected.d, config), config.network)}
        />
        <p className="text-13 text-text-2">
          Paste it where the Buy button goes. Load the script once per page, with one element per
          product.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-24">
      <section className="flex flex-col gap-12">
        <h3 className="text-15 font-semibold">Put a Buy button on your site</h3>
        {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
        {snippet}
      </section>
      <DomainGuide view={view} nip05={config.nip05} />
    </div>
  );
}
