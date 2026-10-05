import type { OrderBackend, OrderRecord, StorePinsRecord } from '@elisym/commerce/buyer';

const DATABASE_NAME = 'elisym-checkout';
const DATABASE_VERSION = 1;
const ORDERS = 'orders';
const STORES = 'stores';
const BY_PRODUCT = 'productAddress';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
  });
}

/** Abort a transaction that may already have ended; the caller's own error is what matters. */
function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Already committed or aborted.
  }
}

export function openOrderDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Reading `indexedDB` itself throws where storage is blocked: a refusal, not a crash.
    const request = (factory ?? indexedDB).open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const orders = database.createObjectStore(ORDERS, { keyPath: 'orderId' });
      orders.createIndex(BY_PRODUCT, BY_PRODUCT);
      database.createObjectStore(STORES, { keyPath: 'storePubkey' });
    };
    request.onsuccess = () => {
      const database = request.result;
      // A newer version opened in another tab: step aside rather than block it.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The order database is blocked by another tab'));
  });
}

/**
 * The widget's order records in IndexedDB. Each `transact*` is ONE readwrite
 * transaction with strict durability: the read, the core's rule and the write
 * happen in it, and it resolves only once committed - a write that did not
 * commit did not happen, and the caller never opens a wallet on it.
 */
export class IndexedDbOrderBackend implements OrderBackend {
  constructor(private readonly database: IDBDatabase) {}

  async read(orderId: string): Promise<OrderRecord | undefined> {
    const transaction = this.database.transaction(ORDERS, 'readonly');
    return (await requestResult(transaction.objectStore(ORDERS).get(orderId))) as
      | OrderRecord
      | undefined;
  }

  async forProduct(productAddress: string): Promise<OrderRecord[]> {
    const transaction = this.database.transaction(ORDERS, 'readonly');
    return (await requestResult(
      transaction.objectStore(ORDERS).index(BY_PRODUCT).getAll(productAddress),
    )) as OrderRecord[];
  }

  /** Every order record of this browser (on this site), read only: "Your purchases". */
  async all(): Promise<OrderRecord[]> {
    const transaction = this.database.transaction(ORDERS, 'readonly');
    return (await requestResult(transaction.objectStore(ORDERS).getAll())) as OrderRecord[];
  }

  private async transact<T>(
    storeName: string,
    run: (store: IDBObjectStore) => Promise<{ commit: boolean; result: T }>,
  ): Promise<T> {
    const transaction = this.database.transaction(storeName, 'readwrite', {
      durability: 'strict',
    });
    const done = transactionDone(transaction);
    // `done` settles with the transaction; the request that failed is the error to report.
    done.catch(() => undefined);
    let outcome: { commit: boolean; result: T };
    try {
      outcome = await run(transaction.objectStore(storeName));
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => undefined);
      throw error;
    }
    if (!outcome.commit) {
      abortQuietly(transaction);
      await done.catch(() => undefined);
      return outcome.result;
    }
    await done;
    return outcome.result;
  }

  transactProduct<T>(
    productAddress: string,
    fn: (records: readonly OrderRecord[]) => { write?: readonly OrderRecord[]; result: T },
  ): Promise<T> {
    return this.transact(ORDERS, async (orders) => {
      const records = (await requestResult(
        orders.index(BY_PRODUCT).getAll(productAddress),
      )) as OrderRecord[];
      const { write, result } = fn(records);
      if (write === undefined || write.length === 0) {
        return { commit: false, result };
      }
      for (const record of write) {
        orders.put(record);
      }
      return { commit: true, result };
    });
  }

  async readPins(storePubkey: string): Promise<StorePinsRecord | undefined> {
    const transaction = this.database.transaction(STORES, 'readonly');
    return (await requestResult(transaction.objectStore(STORES).get(storePubkey))) as
      | StorePinsRecord
      | undefined;
  }

  transactPins<T>(
    storePubkey: string,
    fn: (pins: StorePinsRecord | undefined) => { write?: StorePinsRecord; result: T },
  ): Promise<T> {
    return this.transact(STORES, async (stores) => {
      const current = (await requestResult(stores.get(storePubkey))) as StorePinsRecord | undefined;
      const { write, result } = fn(current);
      if (write === undefined) {
        return { commit: false, result };
      }
      stores.put(write);
      return { commit: true, result };
    });
  }
}
