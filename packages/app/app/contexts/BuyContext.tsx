import {
  prepareEncryptedFileInput,
  buildPaymentInstructions,
  classifyJobError,
  estimatePriorityFeeMicroLamports,
  getProtocolConfig,
  getProtocolProgramId,
  SolanaPaymentStrategy,
  toDTag,
  type CapabilityCard,
  type FileAttachment,
  type PaymentRequestData,
  type TransportKind,
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
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
// VersionedTransaction is the only @solana/web3.js type we still touch: the
// wallet-adapter API (`signTransaction` / `sendTransaction`) accepts either
// legacy Transaction or VersionedTransaction. Once wallet-adapter exposes a
// Kit-native sign path, this import goes away. Do not grow web3.js usage
// elsewhere in this file - everything else is Kit.
import { VersionedTransaction } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import { invalidateWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { SDK_CLUSTER, SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { decodeResult, resultDisplay } from '~/lib/fileResult';
import { formatCardPrice } from '~/lib/formatPrice';
import { cacheSet } from '~/lib/localCache';

const COMPUTE_UNIT_LIMIT = 200_000;
const PRIORITY_FEE_PERCENTILE = 75;
const PROTOCOL_PROGRAM_ID = getProtocolProgramId(SDK_CLUSTER);
const kitRpc = createSolanaRpc(SOLANA_RPC_URL);
const payment = new SolanaPaymentStrategy();
// The browser can only receive a file result over the encrypted-Blossom transport
// (iroh is node-only), so it advertises blossom as its sole receive transport. This
// also makes a large text result spill to a fetchable blossom member.
const WEB_ACCEPT_TRANSPORTS: TransportKind[] = ['blossom'];

// Sync subscription window before a paid job flips to background polling.
// Matches the MCP 10-min cap; the result (kind 6100) persists on the relays.
const JOB_WAIT_TIMEOUT_MS = 600_000;
// Cadence for re-polling the relays for a paid-but-not-yet-delivered result.
const PENDING_POLL_INTERVAL_MS = 120_000;
// Stop polling a pending job after this age (mirrors the provider MAX_PAID_AGE).
const PENDING_POLL_MAX_MS = 24 * 60 * 60 * 1000;
// History statuses worth re-polling: `pending` (sync window elapsed) and
// `payment-completed` (tab closed after paying, before the result arrived).
const RESUMABLE_PENDING_STATUSES = new Set(['pending', 'payment-completed']);

/**
 * The payment tx landed in a block but reverted on-chain (no funds moved). Distinct
 * from a confirmation/network failure so the catch can mark a genuine revert 'error'
 * (not recoverable) while a maybe-landed failure becomes resumable 'pending'.
 */
class PaymentRevertedError extends Error {}

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
 * VersionedTransaction. See useBuyCapability history for the full rationale.
 */
async function buildVersionedPaymentTransaction(
  paymentRequest: PaymentRequestData,
  payerAddress: string,
  jobEventId: string,
): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const payerSigner = createNoopSigner(address(payerAddress));
  const instructions = await buildPaymentInstructions(paymentRequest, payerSigner, {
    jobEventId,
    programId: PROTOCOL_PROGRAM_ID,
  });
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
  return {
    tx: VersionedTransaction.deserialize(wireBytes),
    blockhash: latestBlockhash.blockhash,
    // web3.js `confirmTransaction` strategy form takes a number; kit returns a bigint slot.
    lastValidBlockHeight: Number(latestBlockhash.lastValidBlockHeight),
  };
}

export interface ActiveBuySession {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  cardName: string;
  jobId: string | null;
  buying: boolean;
  result: string | null;
  error: string | null;
  /**
   * `true` once the on-chain payment has been confirmed and the
   * payment-completed feedback has been published. Stays `true` even after
   * an error arrives so the UI can distinguish "paid + provider failed"
   * (refundable / recoverable) from "never paid" (just retry).
   */
  paid: boolean;
  /**
   * `true` when payment succeeded but the result has not arrived within the
   * sync window. NOT an error - the provider may still be working and the
   * result persists on the relays. Background polling flips this back to a
   * `result` once it lands.
   */
  pending: boolean;
  lastInput: string;
  rated: boolean;
  /** Solana tx signature of the confirmed payment, attached to a later rating as proof. */
  txHash?: string;
  /**
   * When the job carried a file INPUT, its attachment descriptor - so the modal
   * shows a live input preview without waiting for a history refresh. With deferred
   * upload the bytes are on Blossom only after pay-time, so the live preview loads
   * post-payment; history always works.
   */
  promptAttachment?: FileAttachment;
  /** The agent the input was encrypted to = the decrypt counterparty for the input. */
  promptProviderPubkey?: string;
  /** When the result is file(s), the (small) attachment descriptors - never the bytes. */
  resultAttachments?: FileAttachment[];
  /** The result-event author, used to decrypt the blossom file output(s). */
  resultProviderPubkey?: string;
}

interface BuyArgs {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  card: CapabilityCard;
}

interface BuyCtx {
  session: ActiveBuySession | null;
  buy: (args: BuyArgs, input: string, file?: File) => Promise<void>;
  rate: (positive: boolean) => Promise<void>;
}

const Ctx = createContext<BuyCtx | null>(null);

export function BuyProvider({ children }: { children: ReactNode }) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const wallet = publicKey?.toBase58() ?? '';
  const { jobs, saveJob, updateJob } = useJobHistory({ wallet });

  const [session, setSession] = useState<ActiveBuySession | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup the active subscription only when the provider itself unmounts -
  // i.e. when the whole app tears down (tab close / SPA reload). Crucially
  // this no longer fires on per-route navigation, which is the entire point
  // of lifting this out of the agent page.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const buying = session?.buying ?? false;
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
    async (args: BuyArgs, input: string, file?: File) => {
      if (session?.buying) {
        return;
      }
      const { agentPubkey, agentName, agentPicture, card } = args;
      const isFree = (card.payment?.job_price ?? 0) === 0;
      if (!isFree && !publicKey) {
        toast.error('Connect your wallet first');
        return;
      }

      // Snapshot wallet-scoped history mutators at click time. If the user
      // disconnects mid-job, useJobHistory({ wallet: '' }) flips to no-op
      // saveJob/updateJob and we'd silently drop status writes; the closure
      // here keeps writing to the wallet that was connected at click.
      const snapshotSaveJob = saveJob;
      const snapshotUpdateJob = updateJob;

      const cardName = card.name;
      const sessionMatches = (s: ActiveBuySession | null): s is ActiveBuySession =>
        !!s && s.agentPubkey === agentPubkey && s.cardName === cardName;

      setSession({
        agentPubkey,
        agentName,
        agentPicture,
        cardName,
        jobId: null,
        buying: true,
        result: null,
        error: null,
        paid: false,
        pending: false,
        lastInput: input,
        rated: false,
      });

      const toastId = toast.loading('Submitting job...');

      try {
        const identity = idCtx.identity;
        const capability = toDTag(cardName);

        // Encrypt + build the input descriptor BEFORE submitting (so an executable/
        // oversize rejection happens pre-payment), but DEFER the byte upload: Blossom
        // is content-addressed so the url is known from the ciphertext sha256. We
        // upload only once the provider quotes a price (see the payment-required
        // handler), so an unresponsive provider never costs a wasted upload. The
        // browser uses the blossom transport only (iroh is node-only).
        let attachment: FileAttachment | undefined;
        let uploadInput: (() => Promise<void>) | undefined;
        if (file) {
          const prepared = await prepareEncryptedFileInput({
            file,
            providerPubkey: agentPubkey,
            identity,
            blossom: client.blossom,
          });
          attachment = prepared.attachment;
          uploadInput = prepared.upload;
          // Show the input preview live. NIP-44 is symmetric, so the customer
          // decrypts its own input against `agentPubkey`. (With deferred upload the
          // bytes land on Blossom only at pay-time, so this preview resolves after
          // payment; the history path always works.)
          setSession((prev) =>
            sessionMatches(prev)
              ? {
                  ...prev,
                  promptAttachment: prepared.attachment,
                  promptProviderPubkey: agentPubkey,
                }
              : prev,
          );
        }

        const jobEventId = await client.marketplace.submitJobRequest(identity, {
          input,
          capability,
          providerPubkey: agentPubkey,
          acceptTransports: WEB_ACCEPT_TRANSPORTS,
          ...(attachment ? { attachment } : {}),
        });
        setSession((prev) => (sessionMatches(prev) ? { ...prev, jobId: jobEventId } : prev));

        snapshotSaveJob({
          jobEventId,
          agentPubkey,
          agentName,
          agentPicture,
          capability,
          status: 'submitted',
          createdAt: Date.now(),
        });

        toast.loading('Waiting for provider...', { id: toastId });

        // Tracks whether on-chain payment settled, so a later subscription
        // timeout is treated as "still processing" (pending) rather than an
        // error. Closure-local so it survives across the async callbacks.
        let paidLocally = false;
        // Set once the payment tx is broadcast (signature obtained) but before
        // confirmation completes. A wait-window timeout in that window is NOT a hard
        // failure - the tx may still land - so the timeout marks it resumable-pending.
        let paymentSubmitted = false;

        // Guards against a DUPLICATE `payment-required` event triggering a second
        // on-chain payment for the same job. Set synchronously at the top of the
        // handler (before any await), so two events that interleave at the await
        // points can't both reach `sendTransaction`. `paidLocally` can't serve this:
        // it flips only after the whole flow completes, by which point both
        // transactions would already be signed and broadcast.
        let paymentInitiated = false;

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
                setSession((prev) => (sessionMatches(prev) ? { ...prev, buying: false } : prev));
                cleanupRef.current?.();
                cleanupRef.current = null;
                return;
              }

              // Synchronous double-payment guard - must run before the first await.
              if (paymentInitiated) {
                return;
              }
              paymentInitiated = true;

              try {
                // Refuse to pay a card whose recipient we cannot verify: no
                // advertised address, or a chain we don't settle on. Mirrors
                // the MCP "Cannot verify payment recipient" guard - without a
                // known recipient a provider could redirect funds anywhere.
                const recipientAddress = card.payment?.address;
                if (!recipientAddress) {
                  throw new Error(
                    'Cannot verify payment recipient - the provider published no payment ' +
                      'address for this product. Refusing to proceed.',
                  );
                }
                if (card.payment?.chain !== 'solana') {
                  throw new Error(
                    `Unsupported payment chain "${card.payment?.chain ?? 'unknown'}" - ` +
                      'only Solana payments are supported. Refusing to proceed.',
                  );
                }

                const protocolConfig = await getProtocolConfig(kitRpc, PROTOCOL_PROGRAM_ID);

                // Bound the charge to the advertised price (subunits). Without
                // this a malicious provider can inflate `paymentRequest.amount`
                // after the customer committed (bait-and-switch). A card with no
                // advertised price (free, or a `payment` block lacking `job_price`)
                // is bounded to 0 - so a "free" card that then demands payment is
                // rejected rather than left unbounded. `job_price` is an integer
                // subunit value; coerce via BigInt with no float math.
                const maxAmountLamports = BigInt(card.payment?.job_price ?? 0);

                const validationError = payment.validatePaymentRequest(
                  paymentRequestJson,
                  { feeBps: protocolConfig.feeBps, treasury: protocolConfig.treasury },
                  recipientAddress,
                  { maxAmountLamports },
                );
                if (validationError) {
                  throw new Error(validationError.message);
                }

                const paymentRequest: PaymentRequestData = JSON.parse(paymentRequestJson);

                // The card advertises a price in ONE asset; refuse a request that
                // switches the asset (e.g. a SOL-priced card quoting the same
                // numeric amount in USDC subunits). `maxAmountLamports` bounds only
                // the number, not the currency, so without this a provider could
                // bait-and-switch the asset after the customer committed. Card
                // `token` absent = native SOL; request `asset` absent = native SOL.
                const cardToken = card.payment?.token ?? 'sol';
                const cardMint = card.payment?.mint;
                const requestChain = paymentRequest.asset?.chain ?? 'solana';
                const requestToken = paymentRequest.asset?.token ?? 'sol';
                const requestMint = paymentRequest.asset?.mint;
                if (
                  requestChain !== 'solana' ||
                  requestToken !== cardToken ||
                  requestMint !== cardMint
                ) {
                  throw new Error(
                    'Payment asset mismatch: the signed request charges a different asset than ' +
                      'the card advertises. Refusing to proceed.',
                  );
                }

                // Defense-in-depth cross-check: when the provider advertised an
                // `amount` on the payment-required feedback, it must match
                // `paymentRequest.amount` (what the signed request actually moves) -
                // catches a provider that quoted low then signed high. A missing/zero
                // advertised amount has nothing to cross-check; the real bound is
                // `maxAmountLamports` (<= the card price) + `validatePaymentRequest`
                // + the asset check above.
                if (amount !== undefined && amount !== 0 && amount !== paymentRequest.amount) {
                  throw new Error(
                    `Payment amount mismatch: feedback advertised ${amount} but the signed ` +
                      `request charges ${paymentRequest.amount}. Refusing to proceed.`,
                  );
                }

                // The provider has quoted, so it's engaged - upload the deferred input
                // NOW, before asking for payment. A failure aborts here with no payment
                // (no paid-but-no-input); an unresponsive provider that never quotes
                // means this never runs and the file is never uploaded.
                if (uploadInput) {
                  toast.loading('Uploading file...', { id: toastId });
                  await retryWithBackoff(uploadInput);
                }

                const amountLabel = formatCardPrice(card.payment, paymentRequest.amount);
                toast.loading(`Approve the ${amountLabel} payment in your wallet...`, {
                  id: toastId,
                });

                const {
                  tx: versionedTx,
                  blockhash,
                  lastValidBlockHeight,
                } = await buildVersionedPaymentTransaction(
                  paymentRequest,
                  publicKey.toBase58(),
                  jobEventId,
                );
                const signature = await sendTransaction(versionedTx, connection);
                paymentSubmitted = true;
                // Persist the tx signature immediately - the payment is now on-chain.
                // If confirmTransaction throws (an RPC hiccup after the tx landed) or the
                // confirmation publish below exhausts its retries, the catch marks the job
                // 'error', but this merge keeps the signature so a successful payment is
                // never discarded and can be reconciled from history.
                snapshotUpdateJob(jobEventId, { txHash: signature });
                // Strategy form (blockhash + lastValidBlockHeight) so a dropped tx rejects
                // at blockhash expiry instead of hanging `buying` forever - the deprecated
                // single-signature form has no expiry. Then inspect the result: a tx can
                // land in a block yet revert (err non-null) without throwing; treating that
                // as success would publish a payment-completed for an unpaid job.
                const confirmation = await connection.confirmTransaction(
                  { signature, blockhash, lastValidBlockHeight },
                  'confirmed',
                );
                if (confirmation.value.err) {
                  throw new PaymentRevertedError(
                    `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
                  );
                }
                invalidateWalletBalances(queryClient, publicKey.toBase58());

                await retryWithBackoff(() =>
                  client.marketplace.submitPaymentConfirmation(
                    identity,
                    jobEventId,
                    agentPubkey,
                    signature,
                    SOLANA_CLUSTER,
                  ),
                );

                snapshotUpdateJob(jobEventId, {
                  status: 'payment-completed',
                  paymentAmount: amount,
                  txHash: signature,
                });
                paidLocally = true;
                setSession((prev) =>
                  sessionMatches(prev) ? { ...prev, paid: true, txHash: signature } : prev,
                );

                toast.loading('Payment sent, waiting for result...', { id: toastId });
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Payment failed';
                // If the tx was broadcast (signature obtained) but confirmation failed
                // for a reason OTHER than an on-chain revert - an RPC error, or the
                // Nostr payment-completed publish exhausting its retries - the payment
                // may have landed. Mark it resumable 'pending' (txHash already saved)
                // so the poller reconciles it, instead of a terminal 'error'. A genuine
                // revert (no funds moved) stays 'error'.
                const resumable = paymentSubmitted && !(err instanceof PaymentRevertedError);
                if (resumable) {
                  snapshotUpdateJob(jobEventId, { status: 'pending' });
                  setSession((prev) => (sessionMatches(prev) ? { ...prev, buying: false } : prev));
                  cleanupRef.current?.();
                  cleanupRef.current = null;
                  toast.dismiss(toastId);
                  toast('Payment sent - still confirming; check job history shortly.');
                  return;
                }
                // A confirmed on-chain revert moved no funds, so drop the signature we
                // optimistically persisted before confirmation - otherwise it could later
                // ride a rating as false payment proof for a payment that never landed.
                snapshotUpdateJob(
                  jobEventId,
                  err instanceof PaymentRevertedError
                    ? { status: 'error', txHash: undefined }
                    : { status: 'error' },
                );
                setSession((prev) =>
                  sessionMatches(prev) ? { ...prev, buying: false, error: msg } : prev,
                );
                cleanupRef.current?.();
                cleanupRef.current = null;
                toast.dismiss(toastId);
                toast.error(msg);
              }
            },

            onResult: (
              content: string,
              eventId: string,
              _attachment?: FileAttachment,
              attachments?: FileAttachment[],
            ) => {
              // The subscription already decoded the envelope, so `content` is the
              // text and `attachments` the file descriptor(s) - do NOT re-decode here.
              const resultAttachments = attachments ?? [];
              const result = resultDisplay({
                text: content || undefined,
                attachments: resultAttachments,
              });
              // The result-event author == the provider we subscribed to (filtered by
              // pubkey), and the CLI provider wraps the blossom content key with that
              // same identity, so agentPubkey is the decrypt sender. Cross-package
              // invariant: a provider that splits signing/encryption keys would break this.
              const resultProviderPubkey = resultAttachments.length > 0 ? agentPubkey : undefined;
              snapshotUpdateJob(jobEventId, { status: 'completed', result });
              cacheSet(`purchase:${jobEventId}`, {
                result,
                eventId,
                receivedAt: Date.now(),
              });
              setSession((prev) =>
                sessionMatches(prev)
                  ? {
                      ...prev,
                      buying: false,
                      pending: false,
                      result,
                      resultAttachments,
                      resultProviderPubkey,
                    }
                  : prev,
              );
              cleanupRef.current = null;
              const agentPath = `/agent/${agentPubkey}`;
              const alreadyOnAgentPage = window.location.pathname === agentPath;
              toast.success(`Result received from ${agentName}`, {
                id: toastId,
                // Override the global 1500ms default so the user has time to
                // notice the result and click through to the provider's page.
                duration: 8000,
                action: alreadyOnAgentPage
                  ? undefined
                  : {
                      label: (
                        <span className="inline-flex items-center gap-4">
                          View
                          <svg
                            aria-hidden
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                          </svg>
                        </span>
                      ),
                      onClick: () => setLocation(`${agentPath}?tab=history`),
                    },
                // Sonner styles `[data-button]` directly with high specificity
                // (4px radius, 24px height, dark-on-light by default), so we
                // override via inline styles - className alone gets beaten.
                actionButtonStyle: {
                  background: '#ffffff',
                  color: '#101012',
                  height: '28px',
                  paddingLeft: '12px',
                  paddingRight: '12px',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '12px',
                  letterSpacing: '0.01em',
                  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.18)',
                },
              });
            },

            onError: (errMsg: string) => {
              snapshotUpdateJob(jobEventId, { status: 'error' });
              setSession((prev) =>
                sessionMatches(prev) ? { ...prev, buying: false, error: errMsg } : prev,
              );
              cleanupRef.current = null;
              const toastMsg =
                classifyJobError(errMsg) === 'agent-unavailable'
                  ? 'Agent unavailable. Try again later.'
                  : errMsg;
              // Sonner does not always swap a multi-step `toast.loading`
              // chain to an error toast when given the same id (the
              // spinner sticks). Dismiss explicitly, then raise a fresh
              // error toast so the customer sees the same message that
              // the inline ErrorMessage card is now displaying.
              toast.dismiss(toastId);
              toast.error(toastMsg);
            },

            onTimeout: () => {
              // After payment, a wait-window timeout is not a failure: the
              // provider may run longer than the sync window and the result
              // persists on the relays. Flip to `pending` and let the
              // background poller pick it up. A timeout before payment means
              // nothing settled - surface it as an error.
              if (!paidLocally) {
                if (paymentSubmitted) {
                  // Tx broadcast but not yet confirmed when the wait window elapsed -
                  // the payment may still land, so mark it resumable-pending (the txHash
                  // is already persisted) and let the poller reconcile it, rather than a
                  // terminal 'error'.
                  snapshotUpdateJob(jobEventId, { status: 'pending' });
                  setSession((prev) => (sessionMatches(prev) ? { ...prev, buying: false } : prev));
                  cleanupRef.current = null;
                  toast.dismiss(toastId);
                  toast('Payment sent - still confirming; check job history shortly.');
                  return;
                }
                snapshotUpdateJob(jobEventId, { status: 'error' });
                setSession((prev) =>
                  sessionMatches(prev)
                    ? { ...prev, buying: false, error: 'Timed out waiting for the provider' }
                    : prev,
                );
                cleanupRef.current = null;
                toast.dismiss(toastId);
                toast.error('Timed out waiting for the provider');
                return;
              }
              snapshotUpdateJob(jobEventId, { status: 'pending' });
              setSession((prev) =>
                // Do not clobber a result the background poller may have
                // already delivered while this subscription was still open.
                sessionMatches(prev) && !prev.result
                  ? { ...prev, buying: false, pending: true }
                  : prev,
              );
              cleanupRef.current = null;
              toast.dismiss(toastId);
              toast.info(
                `Still processing - we'll keep checking for the result from ${agentName}.`,
                { duration: 8000 },
              );
            },
          },
          timeoutMs: JOB_WAIT_TIMEOUT_MS,
          customerSecretKey: identity.secretKey,
        });

        cleanupRef.current = cleanup;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to submit job';
        setSession((prev) =>
          sessionMatches(prev) ? { ...prev, buying: false, error: msg } : prev,
        );
        cleanupRef.current = null;
        toast.dismiss(toastId);
        toast.error(msg);
      }
    },
    [
      session?.buying,
      publicKey,
      client,
      idCtx.identity,
      connection,
      sendTransaction,
      saveJob,
      updateJob,
      queryClient,
      setLocation,
    ],
  );

  // The poller reads the latest jobs from a ref so its interval lifecycle does
  // not depend on the `jobs` array identity. Otherwise every history write
  // (including the poller's own `updateJob`) would change `jobs`, tear down the
  // interval and immediately re-poll - breaking the 120s cadence and risking
  // overlapping polls.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Background recovery for paid jobs whose result did not arrive within the
  // sync window (status `pending`) or whose tab closed after paying but before
  // the result landed (`payment-completed`). The result (kind 6100) persists on
  // the relays, so we re-poll on an interval and deliver whatever arrives. The
  // statuses live in localStorage (useJobHistory), so this also resumes polling
  // after a page reload. Found results update history and, if the job is still
  // the active session, flip it from pending to a result in the UI.
  useEffect(() => {
    if (!wallet) {
      return;
    }
    const identity = idCtx.identity;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        // Recompute eligibility each tick from the latest jobs with a fresh
        // `now`, so the 24h cutoff is honored even on a long-lived tab.
        const now = Date.now();
        const pendingJobs = jobsRef.current.filter(
          (job) =>
            RESUMABLE_PENDING_STATUSES.has(job.status) &&
            !job.result &&
            now - job.createdAt < PENDING_POLL_MAX_MS,
        );
        for (const job of pendingJobs) {
          if (cancelled) {
            return;
          }
          try {
            // Filter by the provider we paid (4th arg) - the same authenticity
            // check the live subscription does. Without it, a forged kind-6100
            // event tagging this request id from any other pubkey could be
            // delivered as the result.
            const resultsByJob = await client.marketplace.queryJobResults(
              identity,
              [job.jobEventId],
              undefined,
              job.agentPubkey,
            );
            if (cancelled) {
              return;
            }
            // Don't revert a result the live subscription may have delivered
            // while this query was in flight.
            const current = jobsRef.current.find((j) => j.jobEventId === job.jobEventId);
            if (current?.result || current?.status === 'completed') {
              continue;
            }
            const res = resultsByJob.get(job.jobEventId);
            // Skip a missing or undecryptable result (the latter surfaces as
            // empty content + decryptionFailed) - the same as the live
            // subscription, which skips undecryptable results rather than
            // delivering them. Marking the paid job completed with an empty
            // result here would falsely report success and stop polling.
            if (!res || res.decryptionFailed) {
              continue;
            }
            // queryJobResults returns the raw decrypted content, so envelope-decode
            // here. A file result with a blossom member becomes downloadable; one
            // without falls back to the notice. Provider = the agent we paid.
            const decoded = decodeResult(res.content);
            const result = resultDisplay(decoded);
            const resultAttachments = decoded.attachments;
            const resultProviderPubkey = resultAttachments.length > 0 ? job.agentPubkey : undefined;
            updateJob(job.jobEventId, { status: 'completed', result });
            cacheSet(`purchase:${job.jobEventId}`, {
              result,
              eventId: job.jobEventId,
              receivedAt: Date.now(),
            });
            setSession((prev) =>
              prev && prev.jobId === job.jobEventId
                ? {
                    ...prev,
                    buying: false,
                    pending: false,
                    result,
                    resultAttachments,
                    resultProviderPubkey,
                  }
                : prev,
            );
          } catch {
            // transient relay error - keep polling on the next tick
          }
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), PENDING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [wallet, idCtx.identity, client, updateJob]);

  const rate = useCallback(
    async (positive: boolean) => {
      if (!session || !session.jobId || session.rated) {
        return;
      }
      const { jobId, agentPubkey, cardName, txHash } = session;
      setSession((prev) => (prev ? { ...prev, rated: true } : prev));
      try {
        const identity = idCtx.identity;
        await client.marketplace.submitFeedback(
          identity,
          jobId,
          agentPubkey,
          positive,
          toDTag(cardName),
          // Attach the payment proof (for the future indexer) and the network.
          { txSignature: txHash, network: SOLANA_CLUSTER },
        );
        await cacheSet(`rated:${jobId}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // silent fail
      }
    },
    [session, client, idCtx.identity],
  );

  const value = useMemo<BuyCtx>(() => ({ session, buy, rate }), [session, buy, rate]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBuy(): BuyCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useBuy must be used within BuyProvider');
  }
  return ctx;
}

interface UseBuyForCardArgs {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  card: CapabilityCard | undefined;
}

export interface ScopedBuyState {
  buy: (input?: string, file?: File) => Promise<void>;
  buying: boolean;
  result: string | null;
  /** When the job carried a file INPUT, its descriptor (for the live input preview). */
  promptAttachment?: FileAttachment;
  promptProviderPubkey?: string;
  /** When the result is file(s), the descriptors needed to fetch + decrypt them. */
  resultAttachments?: FileAttachment[];
  resultProviderPubkey?: string;
  error: string | null;
  /**
   * Whether on-chain payment was completed for the current session before
   * the terminal state was reached. Used by the error UI to surface a
   * recovery hint when an "Agent unavailable" failure follows a paid job.
   */
  paid: boolean;
  /**
   * `true` when payment succeeded but the result has not arrived yet and is
   * being polled in the background. The UI shows a "still processing" state
   * rather than an error.
   */
  pending: boolean;
  jobId: string | null;
  rate: (positive: boolean) => Promise<void>;
  rated: boolean;
  lastInput: string;
}

export function useBuyForCard(args: UseBuyForCardArgs): ScopedBuyState | null {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useBuyForCard must be used within BuyProvider');
  }
  const { agentPubkey, agentName, agentPicture, card } = args;
  const { session, buy: globalBuy, rate: globalRate } = ctx;

  const cardName = card?.name;
  const matches = !!(
    cardName &&
    session &&
    session.agentPubkey === agentPubkey &&
    session.cardName === cardName
  );

  const buy = useCallback(
    async (input = '', file?: File) => {
      if (!card) {
        return;
      }
      await globalBuy({ agentPubkey, agentName, agentPicture, card }, input, file);
    },
    [globalBuy, agentPubkey, agentName, agentPicture, card],
  );

  const rate = useCallback(
    async (positive: boolean) => {
      if (!matches) {
        return;
      }
      await globalRate(positive);
    },
    [globalRate, matches],
  );

  if (!card) {
    return null;
  }

  return {
    buy,
    // `buying` is global on purpose: if any session is in flight, every other
    // card's Buy button must stay disabled (single-job invariant, lifted from
    // the previous per-page hook).
    buying: session?.buying ?? false,
    result: matches ? (session?.result ?? null) : null,
    promptAttachment: matches ? session?.promptAttachment : undefined,
    promptProviderPubkey: matches ? session?.promptProviderPubkey : undefined,
    resultAttachments: matches ? session?.resultAttachments : undefined,
    resultProviderPubkey: matches ? session?.resultProviderPubkey : undefined,
    error: matches ? (session?.error ?? null) : null,
    paid: matches ? (session?.paid ?? false) : false,
    pending: matches ? (session?.pending ?? false) : false,
    jobId: matches ? (session?.jobId ?? null) : null,
    rate,
    rated: matches ? (session?.rated ?? false) : false,
    lastInput: matches ? (session?.lastInput ?? '') : '',
  };
}
