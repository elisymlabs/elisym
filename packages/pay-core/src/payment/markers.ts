/**
 * The public markers an elisym payment carries, so a reader of the chain can
 * tell an elisym commerce payment from an agent job and from everything else.
 *
 * A marker is a LABEL, never evidence: nothing here is an input to any
 * verifier, a payment without one is credited exactly as before, and anyone can
 * write one. What they buy is a count of marked transfers from public data.
 *
 * - Solana: an SPL Memo instruction. A commerce payment carries the fixed text
 *   `elisym:commerce`; an agent-job payment carries `elisym:v1:<jobEventId>`.
 * - Tempo: the memo word itself. A commerce order's memo is 32 bytes of hash,
 *   so the marked form spends its first four on a fixed magic and keeps 28
 *   bytes (224 bits) of the same hash as the binding.
 */

/** The SPL Memo text a commerce payment carries on Solana. */
export const ELISYM_COMMERCE_MEMO = 'elisym:commerce';

/** The SPL Memo prefix an agent-job payment carries on Solana, followed by the job event id. */
export const ELISYM_JOB_MEMO_PREFIX = 'elisym:v1:';

/**
 * The first four bytes of a marked Tempo commerce memo: the first four bytes of
 * `sha256("elisym-memo-marker:commerce:v1")`. `0xfa` never starts valid UTF-8,
 * and a random memo carries it by chance once in 2^32.
 */
export const TEMPO_COMMERCE_MEMO_MAGIC = '0xfab22e7e';

const LEGACY_TEMPO_MEMO_RE = /^0x[0-9a-f]{64}$/;
const MARKED_TEMPO_MEMO_RE = /^0xfab22e7e[0-9a-f]{56}$/;
/** `0x` plus the 28 hash bytes the marked form keeps, as hex characters. */
const MARKED_BINDING_END = 2 + 56;

/**
 * The marked form of a commerce order's Tempo memo: the magic, then the first
 * 28 bytes of the legacy memo (which is the order hash). Throws on anything but
 * a lowercase 32-byte memo.
 */
export function markTempoCommerceMemo(legacy: string): string {
  if (!LEGACY_TEMPO_MEMO_RE.test(legacy)) {
    throw new Error('A Tempo memo is 0x followed by 64 lowercase hex characters.');
  }
  return `${TEMPO_COMMERCE_MEMO_MAGIC}${legacy.slice(2, MARKED_BINDING_END)}`;
}

/** Is this a marked Tempo commerce memo (lowercase wire form)? */
export function isTempoCommerceMemo(memo: string): boolean {
  return MARKED_TEMPO_MEMO_RE.test(memo);
}

export type ElisymMemoKind = 'commerce' | 'job' | 'other';

/** What a Solana memo text says about its payment: commerce, agent job, or neither. */
export function classifyElisymMemo(text: string): ElisymMemoKind {
  if (text === ELISYM_COMMERCE_MEMO) {
    return 'commerce';
  }
  if (text.startsWith(ELISYM_JOB_MEMO_PREFIX)) {
    return 'job';
  }
  return 'other';
}
