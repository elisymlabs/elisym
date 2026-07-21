import { getDB, KV_STORE } from './idb';

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}

/**
 * Atomic read-modify-write on one key in a SINGLE IndexedDB transaction.
 *
 * The updater MUST be synchronous: IDB transactions auto-commit when the
 * request queue drains, so an async updater would either throw
 * `TransactionInactiveError` or silently degrade into two transactions
 * (get + put) - the exact lost-update hazard this primitive exists to close.
 *
 * Returning `undefined` from the updater deletes the key. Resolves `true` only
 * when the transaction actually committed - an abort AFTER the updater ran
 * (quota exceeded, storage torn down mid-flight) resolves `false`, so callers
 * never report a write that IDB discarded. An updater throw aborts the
 * transaction (nothing is written).
 */
export async function cacheUpdate<T>(
  key: string,
  updater: (current: T | undefined) => T | undefined,
): Promise<boolean> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const next = updater(getReq.result as T | undefined);
        if (next === undefined) {
          store.delete(key);
        } else {
          store.put(next, key);
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/**
 * List every string key matching the predicate. Same caveat as
 * `cacheDeleteWhere`: the KV store also holds non-cache entries, so
 * predicates must match by their own prefixes, never blanket-true.
 */
export async function cacheListKeys(predicate: (key: string) => boolean): Promise<string[]> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).getAllKeys();
      req.onsuccess = () => {
        const keys: string[] = [];
        for (const key of req.result) {
          if (typeof key === 'string' && predicate(key)) {
            keys.push(key);
          }
        }
        resolve(keys);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Delete every entry whose string key matches the predicate. The KV store
 * also holds non-cache entries (e.g. the keyVault CryptoKey) - predicates
 * must match by their own prefixes, never blanket-true.
 */
export async function cacheDeleteWhere(predicate: (key: string) => boolean): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (typeof key === 'string' && predicate(key)) {
            store.delete(key);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}
