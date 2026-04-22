const DB_NAME = 'elisym-cache';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
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
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}

export async function getCachedImage(url: string): Promise<string | undefined> {
  try {
    const blob = await cacheGet<Blob>(`img:${url}`);
    if (blob instanceof Blob) {
      return URL.createObjectURL(blob);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function cacheImage(url: string): Promise<string | undefined> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return undefined;
    }
    const blob = await resp.blob();
    await cacheSet(`img:${url}`, blob);
    return URL.createObjectURL(blob);
  } catch {
    return undefined;
  }
}
