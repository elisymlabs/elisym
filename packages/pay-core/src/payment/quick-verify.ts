import { type Address, type Rpc, type Signature, type SolanaRpcApi, isAddress } from '@solana/kit';
import type { Network } from '../types';
import type { LoadedAddresses } from './account-keys';
import { mergeAccountKeys } from './account-keys';
import { isReadableTokenRow, readBalance } from './read-balance';

/**
 * Lightweight payment verifier, exported for discovery ranking.
 *
 * Deliberately WITHOUT the length guard its neighbor in `solana.ts` carries:
 * that one refuses a transaction whose balance arrays disagree, because there a
 * misread slot accepts a payment. Here the answer is a ranking hint the file
 * itself calls "not proof", and the undefined-slot check below is what keeps a
 * disagreement from throwing. Stated because the asymmetry is deliberate.
 *
 * Its guards are measured directly, in `tests/quick-verify.test.ts` - every one
 * whose removal changes an ANSWER, the two cache-key components included: drop
 * the recipient and one agent's verdict is served to the next, drop the network
 * and one cluster's is served to the other, and a row holds each.
 *
 * Five guards change no answer and are left stated rather than measured. One
 * is the skip on an unreadable POST amount: `null > n` is false for every `n`
 * a baseline can be, now that `readBalance` refuses a negative one - the only
 * value it ever mattered against - and the compiler keeps the line regardless,
 * for the narrowing. The other four: the
 * `typeof getTransaction` half of the rpc check (the `catch` below reports
 * `rpc_error` anyway, and the `!rpc` half beside it does change the answer, so
 * it has a row),
 * the forever-lifetime of a positive cache entry (measured only inside the
 * negative TTL, so weakening it costs RPC calls and not a verdict),
 * `recipientIdx !== -1` (the undefined-slot check below catches the same input),
 * and the `delete` before re-caching an expired negative (the `set` overwrites
 * it regardless; only LRU position moves). `MAX_CACHE_ENTRIES` is named
 * separately below.
 *
 * Nothing in this monorepo calls it today - it is public surface for callers
 * building their own ranking, and that is worth saying out loud, because a
 * reader who assumes a caller assumes a test harness too.
 *
 * Unlike `SolanaPaymentStrategy.verifyPayment`, this is a single-shot check
 * with no retries: discovery cannot afford the 30-second confirmation budget
 * the customer-side verifier uses. If the RPC has not seen the transaction
 * yet, we treat the agent as "no verified paid job" rather than blocking.
 *
 * Positive results are cached forever (Solana txs are immutable once
 * confirmed). Negative results expire after `NEGATIVE_CACHE_TTL_MS` so a
 * just-confirmed tx will be picked up on the next discovery refresh.
 */

export type QuickVerifyReason =
  | 'not_found'
  | 'tx_failed'
  | 'recipient_mismatch'
  | 'rpc_error'
  | 'invalid_input';

export interface QuickVerifyResult {
  /**
   * True when the recipient address received funds in this transaction.
   *
   * NOTE: this is NOT proof of a valid elisym job payment. It does not check
   * the payment `reference` key or that the amount matches the job price - it
   * is a best-effort signal for the fast discovery-ranking path, where the
   * original payment request is unavailable. For an authoritative check
   * (amount + reference) use `SolanaPaymentStrategy.verifyPayment`.
   */
  receivedFunds: boolean;
  txSignature: string;
  reason?: QuickVerifyReason;
}

interface VerifyCacheEntry {
  result: QuickVerifyResult;
  cachedAt: number;
}

const NEGATIVE_CACHE_TTL_MS = 60_000;
// Cap so a long-running process cannot grow the cache without bound (#44).
/**
 * NOT KILLED BY ANY TEST: removing the eviction below costs memory in a
 * long-lived process and nothing else - no answer changes - so it is left
 * stated rather than measured.
 */
const MAX_CACHE_ENTRIES = 5_000;

const verifyCache = new Map<string, VerifyCacheEntry>();

export function clearQuickVerifyCache(): void {
  verifyCache.clear();
}

export async function verifyJobPaymentQuick(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: string,
  expectedRecipient: Address,
  network: Network,
): Promise<QuickVerifyResult> {
  if (!txSignature) {
    return { receivedFunds: false, txSignature: '', reason: 'invalid_input' };
  }
  if (!expectedRecipient || !isAddress(expectedRecipient as string)) {
    return { receivedFunds: false, txSignature, reason: 'invalid_input' };
  }

  // Both the recipient AND the network ride in the key, and for the same
  // reason: a positive verdict is cached forever, and it is a verdict about a
  // (transaction, recipient, cluster) triple rather than about a transaction.
  // Drop the recipient and one agent's `receivedFunds: true` is served to the
  // next agent that asks about the same public signature; drop the network and
  // one cluster's answer serves the other.
  const cacheKey = `${txSignature}:${expectedRecipient}:${network}`;
  const cached = verifyCache.get(cacheKey);
  if (cached) {
    if (cached.result.receivedFunds) {
      return cached.result;
    }
    if (Date.now() - cached.cachedAt < NEGATIVE_CACHE_TTL_MS) {
      return cached.result;
    }
    // Expired negative result - drop it so re-verification can refresh.
    verifyCache.delete(cacheKey);
  }

  const result = await doVerifyOnce(rpc, txSignature as Signature, expectedRecipient);
  // Map preserves insertion order, so evicting the first key is LRU-ish.
  if (verifyCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = verifyCache.keys().next().value;
    if (oldest !== undefined) {
      verifyCache.delete(oldest);
    }
  }
  verifyCache.set(cacheKey, { result, cachedAt: Date.now() });
  return result;
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

async function doVerifyOnce(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: Signature,
  expectedRecipient: Address,
): Promise<QuickVerifyResult> {
  const sigStr = txSignature as string;

  if (!rpc || typeof (rpc as { getTransaction?: unknown }).getTransaction !== 'function') {
    return { receivedFunds: false, txSignature: sigStr, reason: 'rpc_error' };
  }

  let tx: Awaited<ReturnType<ReturnType<Rpc<SolanaRpcApi>['getTransaction']>['send']>>;
  try {
    tx = await rpc
      .getTransaction(txSignature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
  } catch {
    return { receivedFunds: false, txSignature: sigStr, reason: 'rpc_error' };
  }

  if (!tx) {
    return { receivedFunds: false, txSignature: sigStr, reason: 'not_found' };
  }
  if (!tx.meta || tx.meta.err) {
    return { receivedFunds: false, txSignature: sigStr, reason: 'tx_failed' };
  }

  // Lookup-table addresses are part of the transaction and part of the balance
  // arrays, but not part of `accountKeys` - a recipient supplied by a table is
  // invisible to `indexOf`, and the SOL branch below then falls through to
  // `recipient_mismatch` on a payment that actually happened.
  //
  // The envelope is read defensively for the same reason the rows below are:
  // `meta` is `<object|null>` in the spec and has a row of its own, but nothing
  // stops a proxy from omitting `transaction` too, and this runs outside the
  // `try`.
  const message = (tx.transaction as { message?: { accountKeys?: unknown } } | undefined)?.message;
  const accountKeys = mergeAccountKeys(
    message?.accountKeys as readonly string[],
    tx.meta.loadedAddresses as LoadedAddresses | undefined,
  );
  const recipientStr = expectedRecipient as string;

  const recipientIdx = accountKeys.indexOf(recipientStr);
  if (recipientIdx !== -1) {
    const preBalances = tx.meta.preBalances as readonly bigint[] | undefined;
    const postBalances = tx.meta.postBalances as readonly bigint[] | undefined;
    // `Array.isArray`, not truthiness. A non-array does not throw on index
    // access, so this arm looked safe - but a STRING indexes character by
    // character, and the digits that come out pass `readBalance` and become a
    // delta. Answering `true` on a page like that is worse than throwing.
    if (Array.isArray(preBalances) && Array.isArray(postBalances)) {
      const pre = readBalance(preBalances[recipientIdx]);
      const post = readBalance(postBalances[recipientIdx]);
      if (pre !== null && post !== null) {
        const delta = post - pre;
        if (delta > 0n) {
          return { receivedFunds: true, txSignature: sigStr };
        }
      }
    }
  }

  const postTokenBalances = tx.meta.postTokenBalances as readonly TokenBalanceEntry[] | undefined;
  const preTokenBalances = tx.meta.preTokenBalances as readonly TokenBalanceEntry[] | undefined;
  // `Array.isArray` rather than truthiness on BOTH containers: a non-iterable
  // post throws on the `for...of`, and a non-array pre has no `.find` at all -
  // every line in this half runs outside the `try`.
  //
  // A pre container that is PRESENT and unreadable stops the half rather than
  // being treated as absent. The two are not the same answer, for the reason
  // `readBalance` gives one line down: absent means the token account was
  // created in this transaction, so zero is its real baseline, while
  // unreadable means we do not know, and reading it as zero makes whatever the
  // recipient already held look like a credit.
  //
  // The same goes one level down. A pre ROW that cannot be matched - `null`, a
  // string, an object with no `owner` - is not "somebody else's row": it may be
  // the recipient's, and skipping it reads their baseline as absent.
  const preRows = Array.isArray(preTokenBalances) ? preTokenBalances : undefined;
  const preRowsUnreadable =
    preTokenBalances !== undefined &&
    preTokenBalances !== null &&
    (preRows === undefined || !preRows.every(isReadableTokenRow));
  if (Array.isArray(postTokenBalances) && !preRowsUnreadable) {
    for (const post of postTokenBalances) {
      if (!isReadableTokenRow(post) || post.owner !== recipientStr) {
        continue;
      }
      const postAmount = readBalance(post.uiTokenAmount?.amount);
      if (postAmount === null) {
        continue;
      }
      const pre = preRows?.find(
        (entry) => entry.owner === recipientStr && entry.mint === post.mint,
      );
      // A MISSING baseline is a zero baseline - the recipient's token account
      // was created inside this very transaction, which is what a first-ever
      // payment looks like. An UNREADABLE one is not the same thing, and the
      // distinction is the whole reason `readBalance` answers `null`.
      const preAmount = pre === undefined ? 0n : readBalance(pre.uiTokenAmount?.amount);
      if (preAmount === null) {
        continue;
      }
      if (postAmount > preAmount) {
        return { receivedFunds: true, txSignature: sigStr };
      }
    }
  }

  return { receivedFunds: false, txSignature: sigStr, reason: 'recipient_mismatch' };
}
