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
