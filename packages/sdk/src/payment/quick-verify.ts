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
  verified: boolean;
  txSignature: string;
  reason?: QuickVerifyReason;
}

interface VerifyCacheEntry {
  result: QuickVerifyResult;
  cachedAt: number;
}

const NEGATIVE_CACHE_TTL_MS = 60_000;

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
    return { verified: false, txSignature: '', reason: 'invalid_input' };
  }
  if (!expectedRecipient || !isAddress(expectedRecipient as string)) {
    return { verified: false, txSignature, reason: 'invalid_input' };
  }

  const cacheKey = `${txSignature}:${expectedRecipient}`;
  const cached = verifyCache.get(cacheKey);
  if (cached) {
    if (cached.result.verified) {
      return cached.result;
    }
    if (Date.now() - cached.cachedAt < NEGATIVE_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const result = await doVerifyOnce(rpc, txSignature as Signature, expectedRecipient);
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
    return { verified: false, txSignature: sigStr, reason: 'rpc_error' };
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
    return { verified: false, txSignature: sigStr, reason: 'rpc_error' };
  }

  if (!tx) {
    return { verified: false, txSignature: sigStr, reason: 'not_found' };
  }
  if (!tx.meta || tx.meta.err) {
    return { verified: false, txSignature: sigStr, reason: 'tx_failed' };
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
          return { verified: true, txSignature: sigStr };
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
        return { verified: true, txSignature: sigStr };
      }
    }
  }

  return { verified: false, txSignature: sigStr, reason: 'recipient_mismatch' };
}
