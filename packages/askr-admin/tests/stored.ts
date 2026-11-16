import { nip19 } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { vi } from 'vitest';

type Failing = 'getItem' | 'setItem' | 'removeItem';

/** A Storage in memory that records every write and can be told to throw. */
export class MemoryStorage implements Storage {
  [name: string]: unknown;
  readonly items = new Map<string, string>();
  readonly writes: string[] = [];
  readonly failing = new Set<Failing>();

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(name: string): string | null {
    this.fail('getItem');
    return this.items.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.fail('setItem');
    this.writes.push(`${name}=${value}`);
    this.items.set(name, value);
  }

  removeItem(name: string): void {
    this.fail('removeItem');
    this.items.delete(name);
  }

  clear(): void {
    this.items.clear();
  }

  /** Every value stored now, joined: what someone reading the device would see. */
  everything(): string {
    return [...this.items].map(([name, value]) => `${name}=${value}`).join('\n');
  }

  private fail(method: Failing) {
    if (this.failing.has(method)) {
      throw new DOMException('refused', 'QuotaExceededError');
    }
  }
}

/** Put a fresh MemoryStorage in place of the page's localStorage. */
export function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(storage);
  return storage;
}

/** Make reaching localStorage itself throw, as some locked-down browsers do. */
export function blockStorage(): void {
  vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError');
  });
}

/** The ways a secret key could appear in plain form. */
export function plainForms(secretKey: Uint8Array): string[] {
  return [nip19.nsecEncode(secretKey), bytesToHex(secretKey)];
}
