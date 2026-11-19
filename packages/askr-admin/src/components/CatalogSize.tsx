import type { StoreConfig } from '@elisym/askr';
import { useEffect, useState } from 'react';
import type { RelayReader } from '../lib/relay';
import { countListed, readAuthority } from '../lib/store-data';
import { Notice } from './Notice';

interface Props {
  reader: RelayReader;
  now: () => number;
  config: StoreConfig;
  maxProducts: number;
}

/**
 * The admin, CSV and connectors refuse a catalog over the plan, but one
 * published with the store's own catalog key reaches the relay anyway; the
 * assistant then uses only the plan's number of products. Says so when that
 * happens.
 */
export function CatalogSize({ reader, now, config, maxProducts }: Props) {
  const [count, setCount] = useState<number>();

  useEffect(() => {
    let current = true;
    setCount(undefined);
    const read = async () => {
      // A key the owner does not authorize now gives the assistant no products at all.
      const authority = await readAuthority(reader, config.owner, now());
      if (!authority.keys.has(config.catalogKey)) {
        return 0;
      }
      return countListed(reader, config.catalogKey, config.currency, now());
    };
    read()
      .then((listed) => {
        if (current) {
          setCount(listed);
        }
      })
      // Advisory only: a relay that does not answer leaves the notice out.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [reader, now, config.owner, config.catalogKey, config.currency]);

  if (count === undefined || count <= maxProducts) {
    return null;
  }
  return (
    <Notice tone="warn">
      Your catalog has {count} products and your plan indexes up to {maxProducts}, so the assistant
      does not see the last {count - maxProducts} by product ID (in character order). Remove
      products or move to a larger plan.
    </Notice>
  );
}
