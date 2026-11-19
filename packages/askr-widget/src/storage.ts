/** The part of Web Storage the widget uses. */
export interface KeyValueStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function isKeyValueStorage(value: unknown): value is KeyValueStorage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getItem') === 'function' &&
    typeof Reflect.get(value, 'setItem') === 'function' &&
    typeof Reflect.get(value, 'removeItem') === 'function'
  );
}

/**
 * A storage area, or none when the browser refuses it (private mode, blocked
 * site data, a sandboxed frame): touching `localStorage` itself can throw.
 */
export function storageArea(name: 'localStorage' | 'sessionStorage'): KeyValueStorage | undefined {
  try {
    const storage: unknown = Reflect.get(globalThis, name);
    if (!isKeyValueStorage(storage)) {
      return undefined;
    }
    const probe = 'askr:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

export function readItem(storage: KeyValueStorage | undefined, key: string): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Whether the write went through. */
export function writeItem(
  storage: KeyValueStorage | undefined,
  key: string,
  value: string,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(storage: KeyValueStorage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    return;
  }
}
