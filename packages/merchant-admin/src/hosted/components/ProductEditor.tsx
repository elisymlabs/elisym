import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import { type ProductDraft, type ProductProblems, checkProduct } from '../lib/product-fields';
import type { StoreSession } from '../lib/store-session';
import type { ProductRecord } from '../lib/types';
import { BUTTON_SECONDARY, BUTTON_TEXT, TEXT_INPUT } from '../styles';
import { Notice } from './Notice';
import { ProductField } from './ProductField';

interface Props {
  session: StoreSession;
  /** The product edited; undefined for a new one. */
  product: ProductRecord | undefined;
  /** The ids already taken: a new product cannot replace one by accident. */
  takenIds: readonly string[];
  onSaved: () => void;
  onCancel: () => void;
}

export const ID_TAKEN = 'A product with this id exists. Edit that product instead.';

function draftOf(product: ProductRecord | undefined): ProductDraft {
  return {
    d: product?.d ?? '',
    title: product?.title ?? '',
    priceUsd: product?.priceUsd ?? '',
    summary: product?.summary ?? '',
    url: product?.url ?? '',
    description: product?.description ?? '',
    onSale: product?.onSale ?? true,
  };
}

/** A product's fields, checked in the browser with the shared rules, then saved as a whole. */
export function ProductEditor({ session, product, takenIds, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<ProductDraft>(() => draftOf(product));
  const [problems, setProblems] = useState<ProductProblems>({});
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const edit = (field: keyof ProductDraft, value: string | boolean) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const save = async () => {
    setRefusal(undefined);
    const checked = checkProduct(draft);
    if (!checked.ok) {
      setProblems(checked.problems);
      return;
    }
    if (product === undefined && takenIds.includes(checked.d)) {
      setProblems({ d: ID_TAKEN });
      return;
    }
    setProblems({});
    setBusy(true);
    try {
      await session.api.putProduct(checked.d, checked.input);
      onSaved();
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-line rounded-10 flex flex-col gap-12 border p-16">
      <h3 className="text-15 font-semibold">
        {product === undefined ? 'New product' : 'Edit product'}
      </h3>
      <ProductField label="Product id (letters, digits, . _ -)" problem={problems.d}>
        <input
          id="product-d"
          className={TEXT_INPUT}
          value={draft.d}
          disabled={product !== undefined}
          onChange={(event) => edit('d', event.target.value)}
        />
      </ProductField>
      <ProductField label="Title" problem={problems.title}>
        <input
          id="product-title"
          className={TEXT_INPUT}
          value={draft.title}
          onChange={(event) => edit('title', event.target.value)}
        />
      </ProductField>
      <ProductField label="Price, USD" problem={problems.priceUsd}>
        <input
          id="product-price"
          className={TEXT_INPUT}
          inputMode="decimal"
          placeholder="49"
          value={draft.priceUsd}
          onChange={(event) => edit('priceUsd', event.target.value)}
        />
      </ProductField>
      <ProductField label="Summary (optional)" problem={problems.summary}>
        <input
          id="product-summary"
          className={TEXT_INPUT}
          value={draft.summary}
          onChange={(event) => edit('summary', event.target.value)}
        />
      </ProductField>
      <ProductField label="Link, https (optional)" problem={problems.url}>
        <input
          id="product-url"
          className={TEXT_INPUT}
          placeholder="https://example.com/product"
          value={draft.url}
          onChange={(event) => edit('url', event.target.value)}
        />
      </ProductField>
      <ProductField label="Description (optional)" problem={problems.description}>
        <textarea
          id="product-description"
          className={`${TEXT_INPUT} min-h-96`}
          value={draft.description}
          onChange={(event) => edit('description', event.target.value)}
        />
      </ProductField>
      <label className="text-14 flex items-center gap-8">
        <input
          id="product-on-sale"
          type="checkbox"
          checked={draft.onSale}
          onChange={(event) => edit('onSale', event.target.checked)}
        />
        On sale
      </label>
      {refusal === undefined ? null : <Notice tone="error">{refusal}</Notice>}
      <div className="flex items-center gap-12">
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy}
          onClick={() => void save()}
        >
          Save product
        </button>
        <button type="button" className={BUTTON_TEXT} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
