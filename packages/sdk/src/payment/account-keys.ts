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
 * that answers with a STRING for one of them would otherwise be spread
 * element-by-element - a number is not iterable and throws instead, which the
 * retry loop turns into a refusal, so the string is the shape worth guarding. For the WRITABLE half that does not merely add
 * junk keys: it lengthens the merged list ahead of the read-only one and
 * shifts every read-only address onto another account's balance slot. For the
 * read-only half nothing follows it, so the cost is the real addresses that
 * half was carrying - a refusal rather than a misread, which is why the two
 * guards are worth the same line but not the same sentence. A malformed
 * container is therefore not partially trusted -
 * the merge falls back to the static keys alone, which is what this code did
 * before lookup tables were read at all, and which refuses rather than
 * misreads.
 */
export function mergeAccountKeys(
  accountKeys: readonly string[],
  loadedAddresses?: LoadedAddresses,
): readonly string[] {
  // The static half gets the same treatment, and it is the worse one to skip:
  // a string here is spread character by character INSIDE the prefix every
  // index is read against, so every loaded address after it lands on somebody
  // else's balance slot. There is nothing to fall back to, so the answer is no
  // keys at all - which finds no recipient and refuses.
  if (!Array.isArray(accountKeys)) {
    return [];
  }
  if (!loadedAddresses) {
    return accountKeys;
  }
  const { writable, readonly } = loadedAddresses;
  if (!Array.isArray(writable) || !Array.isArray(readonly)) {
    return accountKeys;
  }
  return [...accountKeys, ...writable, ...readonly];
}
