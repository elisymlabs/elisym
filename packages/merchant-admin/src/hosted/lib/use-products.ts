import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './errors';
import type { StoreApi } from './store-session';
import type { ProductRecord } from './types';

export interface ProductsState {
  /** Undefined until the first read answers. */
  products: ProductRecord[] | undefined;
  /** The last read's failure, in a fixed sentence; the products read before are kept. */
  problem: string | undefined;
  reload: () => void;
}

/** The store's products, read on mount and on `reload`; only the newest read's answer counts. */
export function useProducts(api: Pick<StoreApi, 'products'>): ProductsState {
  const [products, setProducts] = useState<ProductRecord[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const reads = useRef(0);

  const reload = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    api.products().then(
      (answer) => {
        if (read === reads.current) {
          setProducts(answer.products);
          setProblem(undefined);
        }
      },
      (error: unknown) => {
        if (read === reads.current) {
          setProblem(errorMessage(error));
        }
      },
    );
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { products, problem, reload };
}
