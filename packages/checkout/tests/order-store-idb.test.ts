import { OrderStore } from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGED,
  orderStoreContract,
  record,
  solanaMarker,
} from '../../commerce/tests/buyer/order-store.contract';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';

orderStoreContract(
  async () => new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())),
);

describe('opening the database', () => {
  it('refuses, rather than throws, where there is no IndexedDB at all', async () => {
    const opening = openOrderDatabase();
    expect(opening).toBeInstanceOf(Promise);
    await expect(opening).rejects.toBeDefined();
  });
});

describe('a write that does not commit', () => {
  /** A database whose readwrite transactions abort right after a put succeeds (quota, a closing database). */
  function abortingAfterPut(database: IDBDatabase): IDBDatabase {
    return new Proxy(database, {
      get(target, property) {
        if (property !== 'transaction') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...parameters: Parameters<IDBDatabase['transaction']>) => {
          const transaction = target.transaction(...parameters);
          const objectStore = transaction.objectStore.bind(transaction);
          transaction.objectStore = (name: string) => {
            const objects = objectStore(name);
            const put = objects.put.bind(objects);
            objects.put = (...values: Parameters<IDBObjectStore['put']>) => {
              const request = put(...values);
              request.addEventListener('success', () => transaction.abort());
              return request;
            };
            return objects;
          };
          return transaction;
        };
      },
    });
  }

  it('is never reported as done', async () => {
    const database = await openOrderDatabase(new IDBFactory());
    const healthy = new OrderStore(new IndexedDbOrderBackend(database));
    await healthy.add(record('one'));
    await healthy.update('one', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const failing = new OrderStore(new IndexedDbOrderBackend(abortingAfterPut(database)));
    await expect(failing.setMarker('one', 2, solanaMarker('m'))).rejects.toBeDefined();
    const stored = await healthy.get('one');
    expect(stored?.state).toBe('ordered');
    expect(stored?.marker).toBeUndefined();
  });
});

describe('reading every record (Your purchases)', () => {
  it('returns the records of every product, and writes nothing', async () => {
    const backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
    const store = new OrderStore(backend);
    await store.add(record('one'));
    await store.add({ ...record('two'), productAddress: '30402:other:product' });
    const all = await backend.all();
    expect(all.map((each) => each.orderId).sort()).toEqual(['one', 'two']);
    expect((await store.get('one'))?.version).toBe(1);
  });
});
