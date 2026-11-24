import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { ProductRecord } from '../lib/types';
import { BUTTON_SECONDARY, BUTTON_TEXT } from '../styles';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  product: ProductRecord;
  /** Whether another product is being changed: one change at a time. */
  locked: boolean;
  onEdit: () => void;
  /** The server's delete outcome, as it answered it. */
  onDeleted: (outcome: string) => void;
}

export const DELETE_EXPLAINED =
  'A product never published is removed. One with a published listing or orders stays in your store, off sale: its orders need it.';

/** One product: its title, price and state, with edit and a confirmed delete. */
export function ProductItem({ session, product, locked, onEdit, onDeleted }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = await session.api.deleteProduct(product.d);
      setConfirming(false);
      onDeleted(answer.outcome);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-line flex flex-col gap-8 border-b pb-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <div className="flex min-w-0 flex-col">
          <span className="text-14 font-medium break-words">{product.title}</span>
          <span className="text-13 text-text-2 font-mono break-all">
            {product.d} - ${product.priceUsd} - {product.onSale ? 'on sale' : 'off sale'}
          </span>
        </div>
        <div className="flex gap-8">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={locked || busy}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={locked || busy || confirming}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      </div>
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">{DELETE_EXPLAINED}</Notice>
          <div className="flex items-center gap-12">
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={busy}
              onClick={() => void remove()}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className={BUTTON_TEXT}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </li>
  );
}
