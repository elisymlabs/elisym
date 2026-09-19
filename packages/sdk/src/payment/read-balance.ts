/**
 * The two reads every verifier here makes of a page it did not write, in ONE
 * place.
 *
 * They lived in `quick-verify.ts` alone, and that is the defect this module
 * exists to end: the rule "a baseline that could not be read is not a zero"
 * was written into the ranking hint and never into `verifyPayment`, where the
 * same page decides whether a job is paid for. Measured on a real mainnet
 * transfer of 0.45 USDC against a price of 1.8: an honest node is refused, and
 * the same page with the baseline's amount blanked to `''` verified. A second
 * copy of a rule is a rule that gets fixed once.
 */

/**
 * A balance as the RPC reports it, or `null` when what came back is not one.
 *
 * `BigInt` fails in two different ways, and the two halves below own one each.
 *
 * It THROWS on `undefined`, on a fractional number and on most non-numeric
 * strings - which is what the `try` is for.
 *
 * It also ACCEPTS things that are not balances, silently: `true` is `1n`, `[]`
 * is `0n`, `[7]` is `7n`, `''` and `'   '` are `0n`, `'0x10'` is `16n`. No
 * `catch` ever sees those. The `typeof` line and the shape test on strings are
 * the only thing between a slot nobody could read and a number somebody then
 * does arithmetic on, and that is the half that invents a credit.
 *
 * `null` rather than `0n`, because the two are not the same answer: a baseline
 * taken for zero makes whatever the recipient already held look like a payment.
 */
export function readBalance(raw: unknown): bigint | null {
  if (typeof raw !== 'bigint' && typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  if (typeof raw === 'string' && !/^-?\d+$/.test(raw)) {
    return null;
  }
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** The two fields a token-balance row is matched on. */
export interface ReadableTokenRow {
  owner: string;
  mint: string;
}

/**
 * Whether a token-balance row can be matched at all.
 *
 * A row is found by owner AND mint, so one without both is not "somebody
 * else's row" - it is a row whose owner we cannot name. Skipping it quietly
 * turns "we could not read the recipient's baseline" into "the recipient had
 * no baseline", and an absent baseline is a legitimate ZERO: it is what a
 * first-ever payment looks like, when the token account is created inside the
 * same transaction. The callers refuse the page instead.
 */
export function isReadableTokenRow<Row>(row: Row): row is Row & ReadableTokenRow {
  return (
    row !== null &&
    typeof row === 'object' &&
    typeof (row as Partial<ReadableTokenRow>).owner === 'string' &&
    typeof (row as Partial<ReadableTokenRow>).mint === 'string'
  );
}
