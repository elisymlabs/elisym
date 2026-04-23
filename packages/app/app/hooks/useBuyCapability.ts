import {
  getProtocolConfig,
  getProtocolProgramId,
  resolveAssetFromPaymentRequest,
  SolanaPaymentStrategy,
  toDTag,
  type CapabilityCard,
  type PaymentRequestData,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

const payment = new SolanaPaymentStrategy();
const PROTOCOL_PROGRAM_ID = getProtocolProgramId('devnet');
const protocolRpc = createSolanaRpc('https://api.devnet.solana.com');

/**
 * Build an unsigned payment transaction for a payment request.
 *
 * Wallet-adapter signs the transaction itself, so the SDK's `buildTransaction`
 * (which requires a Solana Kit `Signer`) is not usable here. We reconstruct
 * the same instruction shape manually.
 *
 * For native SOL: `SystemProgram.transfer` to the provider with the payment
 * `reference` attached as a read-only key, plus a second transfer to the
 * protocol treasury when a fee applies.
 *
 * For SPL (USDC): `CreateAssociatedTokenAccountIdempotent` for the recipient
 * and treasury ATAs followed by `TransferChecked` for provider + fee. Idempotent
 * create is free when the ATA already exists, and costs ~0.00204 SOL of rent
 * otherwise - `useSolGasFeeEstimate` does not yet reflect that for the card
 * preview.
 */
function buildPaymentTransaction(
  paymentRequest: PaymentRequestData,
  payer: PublicKey,
): Transaction {
  const asset = resolveAssetFromPaymentRequest(paymentRequest);
  const feeAmount = paymentRequest.fee_amount ?? 0;
  const providerAmount = paymentRequest.fee_address
    ? paymentRequest.amount - feeAmount
    : paymentRequest.amount;
  if (providerAmount <= 0) {
    throw new Error(`Fee amount (${feeAmount}) exceeds total amount (${paymentRequest.amount}).`);
  }

  const tx = new Transaction();
  const recipient = new PublicKey(paymentRequest.recipient);
  const reference = new PublicKey(paymentRequest.reference);

  if (!asset.mint) {
    const providerIx = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: providerAmount,
    });
    providerIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    tx.add(providerIx);

    if (paymentRequest.fee_address && feeAmount > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: new PublicKey(paymentRequest.fee_address),
          lamports: feeAmount,
        }),
      );
    }
    return tx;
  }

  // SPL path (USDC). Canonical Solana Pay flow: idempotent-create recipient
  // and treasury ATAs (no-op if they exist), then TransferChecked, attaching
  // `reference` as an extra read-only key on the provider transfer so the
  // provider can locate the tx via getSignaturesForAddress(reference).
  const mint = new PublicKey(asset.mint);
  const payerAta = getAssociatedTokenAddressSync(mint, payer);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, recipientAta, recipient, mint));

  const providerTransferIx = createTransferCheckedInstruction(
    payerAta,
    mint,
    recipientAta,
    payer,
    BigInt(providerAmount),
    asset.decimals,
  );
  providerTransferIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  tx.add(providerTransferIx);

  if (paymentRequest.fee_address && feeAmount > 0) {
    const treasury = new PublicKey(paymentRequest.fee_address);
    const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, treasuryAta, treasury, mint));
    tx.add(
      createTransferCheckedInstruction(
        payerAta,
        mint,
        treasuryAta,
        payer,
        BigInt(feeAmount),
        asset.decimals,
      ),
    );
  }

  return tx;
}
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';

const PENDING_CONFIRMATIONS_KEY = 'elisym:pending-confirmations';

interface PendingConfirmation {
  jobEventId: string;
  agentPubkey: string;
  signature: string;
  identityHex: string;
  timestamp: number;
}

function savePendingConfirmation(pc: PendingConfirmation) {
  const existing = JSON.parse(
    localStorage.getItem(PENDING_CONFIRMATIONS_KEY) || '[]',
  ) as PendingConfirmation[];
  existing.push(pc);
  localStorage.setItem(PENDING_CONFIRMATIONS_KEY, JSON.stringify(existing));
}

function removePendingConfirmation(jobEventId: string) {
  const existing = JSON.parse(
    localStorage.getItem(PENDING_CONFIRMATIONS_KEY) || '[]',
  ) as PendingConfirmation[];
  localStorage.setItem(
    PENDING_CONFIRMATIONS_KEY,
    JSON.stringify(existing.filter((p) => p.jobEventId !== jobEventId)),
  );
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
import { track } from '~/lib/analytics';
import { cacheSet } from '~/lib/localCache';
import { useElisymClient } from './useElisymClient';
import { useIdentity } from './useIdentity';
import { useJobHistory } from './useJobHistory';

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
                const protocolConfig = await getProtocolConfig(protocolRpc, PROTOCOL_PROGRAM_ID);

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

                // Build and send transaction. The SDK's buildTransaction
                // requires a Solana Kit Signer, which wallet-adapter does not
                // expose - the wallet signs itself via sendTransaction. So we
                // build an unsigned web3.js Transaction with matching shape.
                const tx = buildPaymentTransaction(paymentRequest, publicKey);
                const { blockhash } = await connection.getLatestBlockhash();
                tx.recentBlockhash = blockhash;
                tx.feePayer = publicKey;

                toast.loading('Approve the transaction in your wallet...', { id: toastId });

                const signature = await sendTransaction(tx, connection);
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
