/**
 * The addresses a v0 transaction pulled in from an Address Lookup Table.
 *
 * Absent on a legacy transaction, and absent from `accountKeys` on a v0 one:
 * with `encoding: 'json'` the RPC returns only the STATIC keys there and puts
 * the rest here. The balance arrays cover all of them, ordered static keys
 * first, then the writable loaded ones, then the read-only loaded ones.
 */
export interface LoadedAddresses {
  readonly writable: readonly string[];
  readonly readonly: readonly string[];
}

/**
 * The account keys a balance array is indexed by, in the order it is indexed.
 *
 * Every reader that pairs an address with a `preBalances`/`postBalances` slot
 * has to go through this: reading `accountKeys` alone means a v0 transaction
 * that put the reference, the recipient or the treasury in a lookup table is
 * read against the wrong slots - or not found at all - though the customer
 * paid.
 *
 * Both halves are checked with `Array.isArray` rather than `?? []`. A proxy
 * that answers with a string or a number for one of them would otherwise be
 * spread element-by-element, which does not merely add junk keys: it LENGTHENS
 * the merged list and shifts every read-only address onto another account's
 * balance slot. A malformed container is therefore not partially trusted -
 * the merge falls back to the static keys alone, which is what this code did
 * before lookup tables were read at all, and which refuses rather than
 * misreads.
 */
export function mergeAccountKeys(
  accountKeys: readonly string[],
  loadedAddresses?: LoadedAddresses,
): readonly string[] {
  if (!loadedAddresses) {
    return accountKeys;
  }
  const { writable, readonly } = loadedAddresses;
  if (!Array.isArray(writable) || !Array.isArray(readonly)) {
    return accountKeys;
  }
  return [...accountKeys, ...writable, ...readonly];
}
