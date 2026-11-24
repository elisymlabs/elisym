import { type ReactNode, useState } from 'react';
import type { StoreSession } from '../lib/store-session';
import type { ProductRecord, StoreView } from '../lib/types';
import { useProducts } from '../lib/use-products';
import { BUTTON_SECONDARY } from '../styles';
import { CsvImport } from './CsvImport';
import { Notice } from './Notice';
import { ProductEditor } from './ProductEditor';
import { ProductItem } from './ProductItem';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

export const PRODUCT_SAVED = 'Product saved.';
export const PRODUCT_REMOVED = 'The product was removed.';
export const PRODUCT_STOPPED =
  'The product has a published listing or orders, so it stays in your store, off sale.';
export const PRODUCT_DELETED = 'The product was deleted or taken off sale.';
export const NO_PRODUCTS = 'No products yet. Add one, or import a CSV file.';

const DELETE_OUTCOMES: Readonly<Record<string, string>> = {
  removed: PRODUCT_REMOVED,
  stopped: PRODUCT_STOPPED,
};

/** The server's delete outcome, in a fixed sentence; an unknown one gets the plain one. */
function deleteOutcomeText(outcome: string): string {
  return (
    (Object.hasOwn(DELETE_OUTCOMES, outcome) ? DELETE_OUTCOMES[outcome] : undefined) ??
    PRODUCT_DELETED
  );
}

type Editing = { kind: 'new' } | { kind: 'edit'; product: ProductRecord };

/** The store's products: list, editor, delete, CSV import, and how many are on sale of the cap. */
export function ProductsTab({ session, view, onChanged }: Props) {
  const { products, problem, reload } = useProducts(session.api);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const cap = view.maxProducts ?? session.meta.pendingMaxProducts;
  const onSale = products?.filter((product) => product.onSale).length ?? 0;

  const changed = (text: string | undefined) => {
    setNotice(text);
    reload();
    onChanged();
  };

  let list: ReactNode;
  if (products === undefined) {
    list =
      problem === undefined ? <p className="text-13 text-text-2">Loading products...</p> : null;
  } else if (products.length === 0) {
    list = <p className="text-13 text-text-2">{NO_PRODUCTS}</p>;
  } else {
    list = (
      <ul id="product-list" className="flex flex-col gap-12">
        {products.map((product) => (
          <ProductItem
            key={product.d}
            session={session}
            product={product}
            locked={editing !== undefined || importing}
            onEdit={() => {
              setNotice(undefined);
              setEditing({ kind: 'edit', product });
            }}
            onDeleted={(outcome) => changed(deleteOutcomeText(outcome))}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-24">
      <div className="flex flex-wrap items-center justify-between gap-12">
        <p id="product-cap" className="text-14">
          On sale: {onSale} of the {cap} your plan allows.
        </p>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={editing !== undefined || importing}
          onClick={() => {
            setNotice(undefined);
            setEditing({ kind: 'new' });
          }}
        >
          Add product
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
      {notice === undefined ? null : <Notice tone="info">{notice}</Notice>}
      {editing === undefined ? null : (
        <ProductEditor
          key={editing.kind === 'edit' ? editing.product.d : ''}
          session={session}
          product={editing.kind === 'edit' ? editing.product : undefined}
          takenIds={(products ?? []).map((product) => product.d)}
          onSaved={() => {
            setEditing(undefined);
            changed(PRODUCT_SAVED);
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {list}
      <CsvImport
        session={session}
        locked={editing !== undefined || importing}
        onBusy={setImporting}
        onImported={() => changed(undefined)}
      />
    </div>
  );
}
