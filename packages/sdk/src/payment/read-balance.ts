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
import { isAddress } from '@solana/kit';

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
 *
 * And never NEGATIVE, in any of the three spellings. A balance is a u64, so a
 * negative one is not a small balance - it is not a balance - and it is the one
 * unreadable value that does worse than read as zero: the delta is `post - pre`,
 * so a baseline of `-5000000` ADDS five million to whatever arrived. Measured on
 * both rails: a transfer of 100 subunits against a price of 1.8M verified.
 */
export function readBalance(raw: unknown): bigint | null {
  if (typeof raw !== 'bigint' && typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    return null;
  }
  try {
    const value = BigInt(raw);
    return value < 0n ? null : value;
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
 *
 * Both have to be ADDRESSES, not merely strings: a mint padded with a space is
 * a string, matches nothing, and lands in the same "no baseline" reading. What
 * this cannot catch is a well-formed address that is simply the wrong one - a
 * page that lies coherently is beyond any shape check, here or anywhere else
 * in the verifier.
 */
export function isReadableTokenRow<Row>(row: Row): row is Row & ReadableTokenRow {
  if (row === null || typeof row !== 'object') {
    return false;
  }
  const { owner, mint } = row as Partial<ReadableTokenRow>;
  return (
    typeof owner === 'string' && typeof mint === 'string' && isAddress(owner) && isAddress(mint)
  );
}
