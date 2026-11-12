import { REQ_BYTES_CAP } from '../constants';

/** Room a REQ needs besides its value list: `["REQ","<id>",{...}]`, the other filter fields. */
const REQ_OVERHEAD_BYTES = 512;

/**
 * Split a filter's value list (authors, `#p`) so each serialized REQ stays
 * under the byte cap (2.4): the relay answers an oversized message with only
 * a NOTICE. Values are hex keys, so characters are bytes.
 */
export function chunkByBytes(
  values: readonly string[],
  capBytes: number = REQ_BYTES_CAP,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = REQ_OVERHEAD_BYTES;
  for (const value of values) {
    // A quoted value and its comma.
    const size = value.length + 3;
    if (current.length > 0 && bytes + size > capBytes) {
      chunks.push(current);
      current = [];
      bytes = REQ_OVERHEAD_BYTES;
    }
    current.push(value);
    bytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
