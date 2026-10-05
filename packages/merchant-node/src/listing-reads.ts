/**
 * Reading many products' listings without overrunning a relay: `'#d'` filters
 * of at most `LISTING_CHUNK_SIZE` ids, at most `MAX_SUBSCRIPTIONS_PER_RELAY`
 * in flight. Pure (no Node API): the node and the admin's browser bundle share it.
 */
import { LISTING_CHUNK_SIZE, MAX_SUBSCRIPTIONS_PER_RELAY } from './constants';

/** Read `ds` in chunks through `readChunk` (one subscription per relay each), a few at a time. */
export async function readListingChunks<T>(
  ds: readonly string[],
  readChunk: (chunk: string[]) => Promise<T[]>,
  inFlight = MAX_SUBSCRIPTIONS_PER_RELAY,
): Promise<T[]> {
  const chunks: string[][] = [];
  for (let start = 0; start < ds.length; start += LISTING_CHUNK_SIZE) {
    chunks.push(ds.slice(start, start + LISTING_CHUNK_SIZE));
  }
  const results: T[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (chunk !== undefined) {
        results[index] = await readChunk(chunk);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, chunks.length) }, worker));
  return results.flat();
}
