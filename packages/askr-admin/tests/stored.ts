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

// cspell:disable-next-line
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function checksumOf(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATORS.forEach((generator, index) => {
      if (((top >>> index) & 1) === 1) {
        checksum ^= generator;
      }
    });
  }
  return checksum;
}

function regroup(values: readonly number[], from: number, to: number, pad: boolean): number[] {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const value of values) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >>> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits > 0) {
    out.push((accumulator << (to - bits)) & ((1 << to) - 1));
  }
  return out;
}

/**
 * A well-formed locked key (valid checksum) with one byte changed: what a
 * damaged or crafted value looks like, e.g. one asking for a huge scrypt cost.
 */
export function withByte(locked: string, offset: number, value: number): string {
  const prefix = 'ncryptsec';
  const words = [...locked.slice(prefix.length + 1, -6)].map((character) =>
    BECH32_CHARSET.indexOf(character),
  );
  const bytes = regroup(words, 5, 8, false);
  bytes[offset] = value;
  const data = regroup(bytes, 8, 5, true);
  const codes = [...prefix].map((character) => character.charCodeAt(0));
  const expanded = [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)];
  const polymod = checksumOf([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...data, ...checksum].map((word) => BECH32_CHARSET[word] ?? '').join('')}`;
}
