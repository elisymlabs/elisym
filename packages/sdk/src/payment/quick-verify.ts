import { type Address, type Rpc, type Signature, type SolanaRpcApi, isAddress } from '@solana/kit';

/**
 * Lightweight payment verifier used by discovery ranking.
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
const MAX_CACHE_ENTRIES = 5_000;

const verifyCache = new Map<string, VerifyCacheEntry>();

export function clearQuickVerifyCache(): void {
  verifyCache.clear();
}

export async function verifyJobPaymentQuick(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: string,
  expectedRecipient: Address,
): Promise<QuickVerifyResult> {
  if (!txSignature) {
    return { receivedFunds: false, txSignature: '', reason: 'invalid_input' };
  }
  if (!expectedRecipient || !isAddress(expectedRecipient as string)) {
    return { receivedFunds: false, txSignature, reason: 'invalid_input' };
  }

  const cacheKey = `${txSignature}:${expectedRecipient}`;
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

  const accountKeys = tx.transaction.message.accountKeys as readonly string[];
  const recipientStr = expectedRecipient as string;

  const recipientIdx = accountKeys.indexOf(recipientStr);
  if (recipientIdx !== -1) {
    const preBalances = tx.meta.preBalances as readonly bigint[] | undefined;
    const postBalances = tx.meta.postBalances as readonly bigint[] | undefined;
    if (preBalances && postBalances) {
      const pre = preBalances[recipientIdx];
      const post = postBalances[recipientIdx];
      if (pre !== undefined && post !== undefined) {
        const delta = BigInt(post) - BigInt(pre);
        if (delta > 0n) {
          return { receivedFunds: true, txSignature: sigStr };
        }
      }
    }
  }

  const postTokenBalances = tx.meta.postTokenBalances as readonly TokenBalanceEntry[] | undefined;
  const preTokenBalances = tx.meta.preTokenBalances as readonly TokenBalanceEntry[] | undefined;
  if (postTokenBalances) {
    for (const post of postTokenBalances) {
      if (post.owner !== recipientStr) {
        continue;
      }
      const pre = preTokenBalances?.find(
        (entry) => entry.owner === recipientStr && entry.mint === post.mint,
      );
      const preAmount = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
      const postAmount = BigInt(post.uiTokenAmount.amount);
      if (postAmount > preAmount) {
        return { receivedFunds: true, txSignature: sigStr };
      }
    }
  }

  return { receivedFunds: false, txSignature: sigStr, reason: 'recipient_mismatch' };
}
