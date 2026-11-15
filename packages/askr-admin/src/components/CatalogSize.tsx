import type { StoreConfig } from '@elisym/askr';
import { useEffect, useState } from 'react';
import type { RelayReader } from '../lib/relay';
import { countListed } from '../lib/store-data';
import { Notice } from './Notice';

interface Props {
  reader: RelayReader;
  now: () => number;
  config: StoreConfig;
  maxProducts: number;
}

/**
 * The admin, CSV and connectors refuse a catalog over the plan, but one
 * published with the store's own catalog key or by a Pay Core store reaches
 * the relay anyway; the assistant then uses only the plan's number of products.
 * Says so when that happens.
 */
export function CatalogSize({ reader, now, config, maxProducts }: Props) {
  const [count, setCount] = useState<number>();
  const role = config.source.kind === 'paycore' ? 'paycore' : 'catalog';

  useEffect(() => {
    let current = true;
    countListed(reader, config.catalogKey, role, now())
      .then((listed) => {
        if (current) {
          setCount(listed);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [reader, now, config.catalogKey, role]);

  if (count === undefined || count <= maxProducts) {
    return null;
  }
  return (
    <Notice tone="warn">
      Your catalog has {count} products and your plan indexes up to {maxProducts}, so the assistant
      does not see the last {count - maxProducts} by product ID. Remove products or move to a larger
      plan.
    </Notice>
  );
}
