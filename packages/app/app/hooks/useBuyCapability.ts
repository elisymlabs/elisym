import {
  buildPaymentInstructions,
  estimatePriorityFeeMicroLamports,
  getProtocolConfig,
  getProtocolProgramId,
  SolanaPaymentStrategy,
  toDTag,
  type CapabilityCard,
  type PaymentRequestData,
} from '@elisym/sdk';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
// VersionedTransaction is the only @solana/web3.js type we still touch: the
// wallet-adapter API (`signTransaction` / `sendTransaction`) accepts either
// legacy Transaction or VersionedTransaction. Once wallet-adapter exposes a
// Kit-native sign path, this import goes away. Do not grow web3.js usage
// elsewhere in this file - everything else is Kit.
import { VersionedTransaction } from '@solana/web3.js';
import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { track } from '~/lib/analytics';
import { cacheSet } from '~/lib/localCache';
import { useElisymClient } from './useElisymClient';
import { useIdentity } from './useIdentity';
import { useJobHistory } from './useJobHistory';

const COMPUTE_UNIT_LIMIT = 200_000;
const PRIORITY_FEE_PERCENTILE = 75;
const PROTOCOL_PROGRAM_ID = getProtocolProgramId('devnet');
const kitRpc = createSolanaRpc('https://api.devnet.solana.com');
const payment = new SolanaPaymentStrategy();

const PENDING_CONFIRMATIONS_KEY = 'elisym:pending-confirmations';

interface PendingConfirmation {
  jobEventId: string;
  agentPubkey: string;
  signature: string;
  identityHex: string;
  timestamp: number;
}

// Local-only resumption queue. A corrupted entry must never block the on-chain
// payment confirmation publish, so all reads/writes fail soft.
function readPendingConfirmations(): PendingConfirmation[] {
  try {
    const raw = localStorage.getItem(PENDING_CONFIRMATIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingConfirmation[]) : [];
  } catch {
    return [];
  }
}

function savePendingConfirmation(pc: PendingConfirmation) {
  try {
    const existing = readPendingConfirmations();
    existing.push(pc);
    localStorage.setItem(PENDING_CONFIRMATIONS_KEY, JSON.stringify(existing));
  } catch {
    // best-effort - resumption queue failures must not abort the publish
  }
}

function removePendingConfirmation(jobEventId: string) {
  try {
    const existing = readPendingConfirmations();
    localStorage.setItem(
      PENDING_CONFIRMATIONS_KEY,
      JSON.stringify(existing.filter((entry) => entry.jobEventId !== jobEventId)),
    );
  } catch {
    // best-effort
  }
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error('Retry exhausted');
}

/**
 * Build an unsigned payment transaction for a payment request via the SDK's
 * Kit-native instruction builder, then bridge to a wallet-adapter-compatible
 * VersionedTransaction.
 *
 * Why bridge instead of using the SDK's `buildTransaction` directly: SDK
 * `buildTransaction` requires a real `TransactionSigner` and signs in place,
 * but wallet-adapter signs through the connected extension. We construct
 * with a `createNoopSigner` (only contributes the fee-payer address), compile
 * to wire bytes, and rehydrate as a VersionedTransaction so wallet-adapter
 * can sign and submit.
 *
 * Includes ComputeBudget set-limit + set-price instructions so the tx carries
 * a priority fee. The SDK applies the same defaults (200k CU limit, 75th
 * percentile priority fee) when it builds tx itself; mirroring them here
 * keeps both paths in lockstep.
 *
 * For SPL/USDC, the SDK builder emits `CreateAssociatedTokenIdempotent`
 * instructions for the recipient (and treasury) ATAs followed by
 * `TransferChecked`. The reference key is attached as a read-only account on
 * the provider transfer.
 */
async function buildVersionedPaymentTransaction(
  paymentRequest: PaymentRequestData,
  payerAddress: string,
): Promise<VersionedTransaction> {
  const payerSigner = createNoopSigner(address(payerAddress));
  const instructions = await buildPaymentInstructions(paymentRequest, payerSigner);
  const priorityFeeMicroLamports = await estimatePriorityFeeMicroLamports(kitRpc, {
    percentile: PRIORITY_FEE_PERCENTILE,
  });
  const { value: latestBlockhash } = await kitRpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => setTransactionMessageComputeUnitLimit(COMPUTE_UNIT_LIMIT, m),
    (m) => setTransactionMessageComputeUnitPrice(priorityFeeMicroLamports, m),
    (m) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        m,
      ),
  );

  const compiled = compileTransaction(message);
  const wireBase64 = getBase64EncodedWireTransaction(compiled);
  const wireBytes = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(wireBytes);
}

interface BuyCapabilityOptions {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  card: CapabilityCard;
}

export function useBuyCapability({
  agentPubkey,
  agentName,
  agentPicture,
  card,
}: BuyCapabilityOptions) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const wallet = publicKey?.toBase58() ?? '';
  const { saveJob, updateJob } = useJobHistory({ wallet });

  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [rated, setRated] = useState(false);
  const [lastInput, setLastInput] = useState<string>('');
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // Warn user before closing tab during active payment
  useEffect(() => {
    if (!buying) {
      return;
    }
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [buying]);

  const buy = useCallback(
    async (input = '') => {
      if (buying) {
        return;
      }
      const isFree = card.payment?.job_price === 0;
      if (!isFree && !publicKey) {
        toast.error('Connect your wallet first');
        return;
      }

      setBuying(true);
      setError(null);
      setResult(null);
      setLastInput(input);

      const toastId = toast.loading('Submitting job...');

      try {
        const identity = idCtx.identity;

        const capability = toDTag(card.name);

        // 1. Submit job request
        const jobEventId = await client.marketplace.submitJobRequest(identity, {
          input,
          capability,
          providerPubkey: agentPubkey,
        });
        setJobId(jobEventId);

        // 2. Save initial job
        saveJob({
          jobEventId,
          agentPubkey,
          agentName,
          agentPicture,
          capability,
          status: 'submitted',
          createdAt: Date.now(),
        });

        toast.loading('Waiting for provider...', { id: toastId });

        // 3. Subscribe to updates
        const cleanup = client.marketplace.subscribeToJobUpdates({
          jobEventId,
          providerPubkey: agentPubkey,
          customerPublicKey: identity.publicKey,
          callbacks: {
            onFeedback: async (status: string, amount?: number, paymentRequestJson?: string) => {
              if (status !== 'payment-required' || !paymentRequestJson) {
                return;
              }
              if (!publicKey) {
                toast.error('Wallet disconnected - reconnect and retry', { id: toastId });
                setBuying(false);
                return;
              }

              try {
                // Fetch on-chain protocol config (fee + treasury) so the
                // validator can verify fee_amount / fee_address match what
                // the protocol currently requires. getProtocolConfig caches
                // for 60s, so back-to-back purchases reuse the same snapshot.
                const protocolConfig = await getProtocolConfig(kitRpc, PROTOCOL_PROGRAM_ID);

                // Validate payment request
                const validationError = payment.validatePaymentRequest(
                  paymentRequestJson,
                  { feeBps: protocolConfig.feeBps, treasury: protocolConfig.treasury },
                  card.payment?.address,
                );
                if (validationError) {
                  throw new Error(validationError.message);
                }

                const paymentRequest: PaymentRequestData = JSON.parse(paymentRequestJson);

                toast.loading('Approve the transaction in your wallet...', { id: toastId });

                const versionedTx = await buildVersionedPaymentTransaction(
                  paymentRequest,
                  publicKey.toBase58(),
                );
                const signature = await sendTransaction(versionedTx, connection);
                await connection.confirmTransaction(signature, 'confirmed');

                // Persist before publishing so we can retry on page reload
                savePendingConfirmation({
                  jobEventId,
                  agentPubkey,
                  signature,
                  identityHex: '',
                  timestamp: Date.now(),
                });

                // Publish payment confirmation with retry
                await retryWithBackoff(() =>
                  client.marketplace.submitPaymentConfirmation(
                    identity,
                    jobEventId,
                    agentPubkey,
                    signature,
                  ),
                );

                removePendingConfirmation(jobEventId);

                updateJob(jobEventId, {
                  status: 'payment-completed',
                  paymentAmount: amount,
                  txHash: signature,
                });

                toast.loading('Payment sent, waiting for result...', { id: toastId });
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Payment failed';
                setError(msg);
                updateJob(jobEventId, { status: 'error' });
                setBuying(false);
                toast.error(msg, { id: toastId });
              }
            },

            onResult: (content: string, eventId: string) => {
              setResult(content);
              updateJob(jobEventId, { status: 'completed', result: content });

              // Store in IndexedDB
              cacheSet(`purchase:${jobEventId}`, {
                result: content,
                eventId,
                receivedAt: Date.now(),
              });

              setBuying(false);
              toast.success('Result received!', { id: toastId });
            },

            onError: (errMsg: string) => {
              setError(errMsg);
              updateJob(jobEventId, { status: 'error' });
              setBuying(false);
              toast.error(errMsg, { id: toastId });
            },
          },
          timeoutMs: 120_000,
          customerSecretKey: identity.secretKey,
        });

        cleanupRef.current = cleanup;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to submit job';
        setError(msg);
        setBuying(false);
        toast.error(msg, { id: toastId });
      }
    },
    [
      buying,
      publicKey,
      client,
      idCtx.identity,
      agentPubkey,
      agentName,
      agentPicture,
      card,
      connection,
      sendTransaction,
      saveJob,
      updateJob,
    ],
  );

  const rate = useCallback(
    async (positive: boolean) => {
      if (!jobId || rated) {
        return;
      }
      setRated(true);
      try {
        const identity = idCtx.identity;
        await client.marketplace.submitFeedback(
          identity,
          jobId,
          agentPubkey,
          positive,
          toDTag(card.name),
        );
        await cacheSet(`rated:${jobId}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // silent fail
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- card.name is stable for the lifetime of this hook
    [jobId, rated, client, idCtx.identity, agentPubkey],
  );

  return { buy, buying, result, error, jobId, rate, rated, lastInput };
}
