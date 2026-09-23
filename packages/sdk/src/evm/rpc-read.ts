/**
 * Readers for values an rpc returns. Every one answers `null` for anything that
 * is not exactly the expected shape - never zero, never an empty list, never a
 * default. The caller decides what `null` means, and for money it always means
 * "refuse" or "this pass is incomplete": an unreadable value is not a zero.
 */

const HEX_RE = /^0x[0-9a-f]*$/;
const WORD_HEX_CHARS = 64;
const ADDRESS_PADDING = '0'.repeat(24);

/** Lowercase `0x` hex of an even number of digits, or `null`. */
export function readHexData(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.toLowerCase();
  return HEX_RE.test(lower) && lower.length % 2 === 0 ? lower : null;
}

/** A JSON-RPC quantity (`0x` hex, no leading zeros required by us), or `null`. */
export function readQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

/**
 * ABI return data of EXACTLY `count` 32-byte words, split - or `null`. Exact,
 * because a contract that answers more or less than the function promises is not
 * the contract we think it is, and `0x` is what an address with no code answers.
 */
export function readWords(value: unknown, count: number): string[] | null {
  const data = readHexData(value);
  if (data === null || data.length !== 2 + count * WORD_HEX_CHARS) {
    return null;
  }
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    words.push(data.slice(2 + index * WORD_HEX_CHARS, 2 + (index + 1) * WORD_HEX_CHARS));
  }
  return words;
}

export function readUint256(word: string | undefined): bigint | null {
  return word !== undefined && /^[0-9a-f]{64}$/.test(word) ? BigInt(`0x${word}`) : null;
}

/** An ABI-encoded address: twelve zero bytes, then the address. Dirty upper bytes are `null`. */
export function readAddressWord(word: string | undefined): string | null {
  if (word === undefined || !/^[0-9a-f]{64}$/.test(word) || !word.startsWith(ADDRESS_PADDING)) {
    return null;
  }
  return `0x${word.slice(24)}`;
}

/** A 32-byte word as it appears in `topics`: `0x` and 64 lowercase hex digits. */
export function readTopicWord(value: unknown): string | null {
  const data = readHexData(value);
  return data !== null && data.length === 2 + WORD_HEX_CHARS ? data : null;
}

/** A topic holding an ABI-encoded address. Dirty upper bytes are `null`, never an address. */
export function readTopicAddress(value: unknown): string | null {
  const word = readTopicWord(value);
  return word === null ? null : readAddressWord(word.slice(2));
}

/** A 32-byte transaction or block hash in wire form. */
export function readTxHash(value: unknown): string | null {
  return readTopicWord(value);
}

/**
 * A block or log index as a plain number. Refuses anything above
 * `Number.MAX_SAFE_INTEGER`, where arithmetic on a block range would start
 * lying - about 285 million years of Tempo blocks away.
 */
export function readBlockNumber(value: unknown): number | null {
  const quantity = readQuantity(value);
  if (quantity === null || quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(quantity);
}

/** A field of an object that may be anything at all. */
export function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** `0x`-prefixed hex of a block number, the form every `eth_` parameter wants. */
export function toQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}
