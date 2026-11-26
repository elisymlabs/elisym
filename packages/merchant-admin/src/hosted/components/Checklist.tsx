import { useEffect, useState } from 'react';
import { type ChecklistState, checklist } from '../lib/checklist';
import type { StoreApi } from '../lib/store-session';
import type { StoreView } from '../lib/types';

interface Props {
  api: Pick<StoreApi, 'products'>;
  view: StoreView;
}

const MARKS: Readonly<Record<ChecklistState, string>> = {
  done: 'Done',
  todo: 'To do',
  unknown: 'Unknown',
};

/** What the store needs before it sells. */
export function Checklist({ api, view }: Props) {
  const [onSale, setOnSale] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let current = true;
    api.products().then(
      ({ products }) => {
        if (current) {
          setOnSale(products.some((product) => product.onSale));
        }
      },
      () => {
        if (current) {
          setOnSale(undefined);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, view]);

  return (
    <section className="flex flex-col gap-8">
      <h2 className="text-16 font-semibold">Checklist</h2>
      <ul className="flex flex-col gap-6">
        {checklist(view, onSale).map((item) => (
          <li key={item.id} className="text-14 flex justify-between gap-16" id={`check-${item.id}`}>
            <span>{item.label}</span>
            <span className={item.state === 'done' ? 'text-text' : 'text-text-2'}>
              {MARKS[item.state]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
