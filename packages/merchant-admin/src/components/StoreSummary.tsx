import type { Snapshot } from '../lib/core';
import { countText } from '../lib/count';
import { Icon } from './Icon';

interface Props {
  snapshot: Snapshot;
  onProducts: () => void;
  onStore: () => void;
}

export function StoreSummary({ snapshot, onProducts, onStore }: Props) {
  const lines = snapshot.allProducts?.lines ?? [];
  const onSale = lines.filter((product) => product.onSale).length;
  const { store } = snapshot;
  return (
    <div className="grid gap-12 sm:grid-cols-2">
      <button
        type="button"
        onClick={onProducts}
        className="rounded-16 border-line bg-surface hover:border-line-2 flex items-center gap-12 border p-16 text-left transition"
      >
        <span className="rounded-10 bg-surface-2 text-text-2 grid size-36 shrink-0 place-items-center">
          <Icon name="box" className="size-18" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-14 block font-semibold">Products</span>
          <span className="text-13 text-text-2 block">{`${onSale} on sale of ${lines.length}`}</span>
        </span>
        <Icon name="chevron" className="text-text-3 size-16" />
      </button>
      <button
        type="button"
        onClick={onStore}
        className="rounded-16 border-line bg-surface hover:border-line-2 flex items-center gap-12 border p-16 text-left transition"
      >
        <span className="rounded-10 bg-surface-2 text-text-2 grid size-36 shrink-0 place-items-center">
          <Icon name="store" className="size-18" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-14 block font-semibold">Store setup</span>
          <span className="text-13 text-text-2 block truncate">
            {`${countText(store.relays.length, 'inbox relay')}, ${countText(store.payoutMediums.length, 'payout network')}`}
          </span>
        </span>
        <Icon name="chevron" className="text-text-3 size-16" />
      </button>
    </div>
  );
}
