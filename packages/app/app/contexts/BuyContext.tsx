import {
  prepareEncryptedFileInput,
  buildAuthMessage,
  buildPaymentInstructions,
  classifyJobError,
  deriveOwnerDelegationAta,
  encodeJobPayload,
  estimatePriorityFeeMicroLamports,
  getDelegation,
  getProtocolConfig,
  getProtocolProgramId,
  LIMITS,
  MAX_PROOF_TTL_SECS,
  mintDelegationNonce,
  assetKey,
  resolveKnownAsset,
  resolveUsdcAsset,
  SolanaPaymentStrategy,
  splAssetsForNetwork,
  toDTag,
  utf8ByteLength,
  type CapabilityCard,
  type FileAttachment,
  type PaymentAssetRef,
  type PaymentInfo,
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
  getBase58Decoder,
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
import { invalidateDelegationStatus } from '~/hooks/useDelegationStatus';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import { fetchWalletBalancesNow, invalidateWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { checkBuyAffordability } from '~/lib/balanceCheck';
import { resolvePaymentAsset } from '~/lib/cardAsset';
import { clearInFlight, recordCompletion } from '~/lib/chatSession';
import { appendPendingEntry, completeEntry, failEntry, recordEntryTxHash } from '~/lib/chatThread';
import { SDK_CLUSTER, SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { decodeResult, resultDisplay } from '~/lib/fileResult';
import { formatCardPrice } from '~/lib/formatPrice';
import { cacheSet } from '~/lib/localCache';
import { rememberJobFile } from '~/lib/retryFiles';

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
// Exported for the Chat tab-open reconcile's re-subscription window.
export const JOB_WAIT_TIMEOUT_MS = 600_000;
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

/**
 * The unseen-badge in-view criterion: a terminal flip stamps `unseen` only
 * when the user is NOT looking at this agent's page - which requires the tab
 * to be visible, not merely on the right path (a result landing in a hidden
 * tab was not seen; the Chat tab's clear effect wipes the flag the moment
 * the tab becomes visible again). Read live inside the callback - never
 * decide against the effect-closure `session`, which survives route
 * navigation by design and would suppress the stamp for the most recent job
 * forever.
 */
function agentPageInView(agentPubkey: string): boolean {
  return (
    typeof window !== 'undefined' &&
    document.visibilityState === 'visible' &&
    window.location.pathname === `/agent/${agentPubkey}`
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
    network: SOLANA_CLUSTER,
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

/**
 * Coarse live phase of the in-flight buy, mirrored from the toast updates so
 * the Chat tab's pending bubble can show a status line without re-deriving it
 * from the 7000 feedback stream.
 */
export type BuyPhase = 'submitting' | 'awaiting-provider' | 'paying' | 'processing';

/**
 * Map a card's payment block to the thread entry's asset descriptor.
 * Undefined => native SOL (back-compat with the price display).
 */
function paymentToAsset(payment: PaymentInfo | undefined): PaymentAssetRef | undefined {
  if (!payment || !payment.token || payment.token === 'sol') {
    return undefined;
  }
  const known = resolveKnownAsset(payment.chain, payment.token, payment.mint);
  if (known) {
    return { chain: known.chain, token: known.token, mint: known.mint, decimals: known.decimals };
  }
  if (payment.decimals === undefined) {
    return undefined;
  }
  return {
    chain: payment.chain,
    token: payment.token,
    mint: payment.mint,
    decimals: payment.decimals,
  };
}

export interface ActiveBuySession {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  cardName: string;
  jobId: string | null;
  buying: boolean;
  /** Present only while `buying`; cleared implicitly by the terminal states. */
  phase?: BuyPhase;
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

/**
 * Session behavior of one send (the stage-2 two-surface rule): `sessionId` is
 * a UUID for a Chat-tab send against a context-capable card, or `null` for a
 * deliberate stateless one-shot (every Products-tab buy, and chat sends on
 * context-off cards) - recorded as such in the thread entry. `token` is the
 * `inFlight` element appended by `resolveSessionForSend`; `buy()` clears it on
 * every exit that did not produce a pending thread entry, and hands off to the
 * pending entry (the durable in-flight signal) once one lands.
 */
export interface BuySessionOptions {
  sessionId: string | null;
  token?: string;
  /**
   * Explicit payment rail from the Products buy button: 'delegated' submits
   * from the allowance or fails loudly (never a silent per-job payment the
   * user did not choose); 'per-job' pays per job even when a delegation
   * would be discovered at click time (the button advertised a per-job
   * payment). Absent = resolve automatically at click time - chat/retry
   * sends, which carry no rail label.
   */
  payment?: 'delegated' | 'per-job';
  /**
   * Network fee a PER-JOB payment would draw from the wallet, in lamports, as
   * the sending surface already sized it - so the click-time balance re-check
   * can cover the fee leg without paying for a second estimate. Absent = 0,
   * i.e. price check only.
   *
   * Surfaces pass it unconditionally. Whether it is actually demanded is
   * `buy()`'s call, because only `buy()` knows whether the allowance rail can
   * still win - and on that rail the provider pays the fee, so charging the
   * customer would refuse a send they can afford.
   */
  gasLamports?: number;
}

interface BuyCtx {
  session: ActiveBuySession | null;
  buy: (
    args: BuyArgs,
    input: string,
    file: File | undefined,
    session: BuySessionOptions,
  ) => Promise<void>;
  rate: (positive: boolean) => Promise<void>;
}

const Ctx = createContext<BuyCtx | null>(null);

export function BuyProvider({ children }: { children: ReactNode }) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  // `signMessage` is optional in the adapter contract - wallets lacking it
  // simply never take the delegated-payment path and pay per-job instead.
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const wallet = publicKey?.toBase58() ?? '';
  const { jobs, saveJob, updateJob, flipJob } = useJobHistory({ wallet });

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
    async (args: BuyArgs, input: string, file: File | undefined, buySession: BuySessionOptions) => {
      const { agentPubkey, agentName, agentPicture, card } = args;
      const identityPubkey = idCtx.identity.publicKey;
      const { sessionId, token: sessionToken } = buySession;
      // The chat composer resolves the session + `inFlight` token BEFORE
      // calling buy(), so every exit that does not produce a pending thread
      // entry must clear the token here (buy()'s silent early returns
      // included); once the pending entry lands it becomes the durable
      // in-flight signal and the token is released.
      let sessionTokenReleased = false;
      const releaseSessionToken = async () => {
        if (sessionTokenReleased || sessionToken === undefined) {
          return;
        }
        sessionTokenReleased = true;
        await clearInFlight(identityPubkey, agentPubkey, sessionToken);
      };
      if (session?.buying) {
        await releaseSessionToken();
        return;
      }
      const isFree = (card.payment?.job_price ?? 0) === 0;
      if (!isFree && !publicKey) {
        toast.error('Connect your wallet first');
        await releaseSessionToken();
        return;
      }

      // Snapshot wallet-scoped history mutators at click time. If the user
      // disconnects mid-job, useJobHistory({ wallet: '' }) flips to no-op
      // saveJob/updateJob and we'd silently drop status writes; the closure
      // here keeps writing to the wallet that was connected at click.
      const snapshotSaveJob = saveJob;
      const snapshotUpdateJob = updateJob;
      const snapshotFlipJob = flipJob;

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
        phase: 'submitting',
        result: null,
        error: null,
        paid: false,
        pending: false,
        lastInput: input,
        rated: false,
      });

      // A paid buy re-reads balances first (see the top of the try below), so
      // name that step rather than announcing a submit that has not started.
      // An asset this cluster cannot pay is skipped outright - the check
      // abstains on it anyway, so the read would be latency for nothing.
      const paymentAsset = isFree ? null : resolvePaymentAsset(card.payment, SOLANA_CLUSTER);
      const needsBalanceRecheck =
        !isFree && !!publicKey && buySession.payment !== 'delegated' && paymentAsset !== null;
      // Everything about the delegated rail that is knowable BEFORE the
      // allowance itself is read: the surface did not force per-job, the card
      // advertises a delegation, the wallet can sign the authorization, and the
      // price is in canonical USDC.
      //
      // Asset IDENTITY, not the card's `token` string: the pull targets the
      // canonical USDC ATA whatever the card claims, so a card that merely
      // calls itself usdc while naming another mint must not read as delegated
      // here. `resolvePaymentAsset` returns null for any non-canonical mint.
      //
      // "Could still win", not "will win" - the rail also needs an ACTIVE
      // covering allowance, and that costs an RPC round trip resolved further
      // down. The gate below re-uses this and adds the narrowing TypeScript
      // needs.
      const delegationCanWin =
        !isFree &&
        buySession.payment !== 'per-job' &&
        card.delegation !== undefined &&
        signMessage !== undefined &&
        paymentAsset !== null &&
        assetKey(paymentAsset) === assetKey(resolveUsdcAsset(SOLANA_CLUSTER));
      const toastId = toast.loading(
        needsBalanceRecheck ? 'Checking your balance...' : 'Submitting job...',
      );

      // Set once the pending thread entry has been written, so the outer catch
      // can fail the entry (job submitted, then client-side failure) while
      // pre-jobEventId failures stay composer-only (no thread entry).
      let threadEntryJobEventId: string | null = null;

      try {
        // The button that got us here was gated on polled balances, which can
        // be well out of date: the interval pauses while the tab is hidden,
        // which is exactly where the user goes to spend. Re-read before the
        // input is encrypted and before the provider is asked to quote, so a
        // wallet drained in that window is refused with our own message rather
        // than costing a provider round trip and a failed entry. This is
        // submit hygiene, not freshness at signing: the payment tx is built
        // much later, after the quote, and the wallet's own simulation stays
        // the arbiter of what signs. A read that fails or times out yields
        // `null` for that asset, which `checkBuyAffordability` abstains on by
        // its own rules.
        //
        // PRICE is checked on every rail that reaches here. An explicit
        // 'delegated' buy does not reach it at all (see `needsBalanceRecheck`):
        // the delegation block below enforces `balance >= price` on the same
        // ATA, with a better-aimed message.
        //
        // FEE is checked only where the allowance rail cannot win - see
        // `delegationCanWin`. Demanding a fee while that rail is still open
        // would refuse a send that settles for free, and `useDelegatedBuyMode`
        // is a render-time read, too stale to rule it out. That leaves a known
        // hole: a card painted 'Use' passes `delegatedCovers`, so
        // `useJobGating` skips affordability outright, and if the allowance
        // lapses between paint and click the fall-back to a per-job payment
        // has had no fee check on either side. Closing it means resolving the
        // rail before this check rather than after.
        if (needsBalanceRecheck && publicKey) {
          // SOL plus the card's own token, never every asset on the cluster -
          // the click waits on the slowest read. SOL is read unconditionally:
          // the fee tier spends it where `railIsPerJob` holds, and where the
          // rail is still open the reading at least keeps the render gate's
          // next fee check fresh - except on a 'Use'-painted card, which skips
          // that check altogether.
          const { solLamports, splRaw } = await fetchWalletBalancesNow(
            queryClient,
            publicKey.toBase58(),
            paymentAsset !== null && paymentAsset.mint !== undefined ? [paymentAsset] : [],
          );
          const railIsPerJob = !delegationCanWin;
          const affordable = checkBuyAffordability({
            card,
            solLamports,
            splRaw,
            gasLamports: railIsPerJob ? (buySession.gasLamports ?? 0) : 0,
            network: SOLANA_CLUSTER,
          });
          if (!affordable.ok) {
            // The outer catch owns every teardown this needs: the session
            // token, the `buying` flag, the error bubble and the toast.
            throw new Error(affordable.tooltip);
          }
          toast.loading('Submitting job...', { id: toastId });
        }

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

        // Envelope-aware pre-submit check: a session-carrying or file job is
        // wrapped in the payload envelope, and JSON escaping can inflate an
        // input that passes the composer's raw-byte check past the NIP-44
        // backstop at submit. Measure the EXACT envelope (the descriptor now
        // exists) against the inline cap, before submit and before any payment.
        if (sessionId !== null || attachment !== undefined) {
          const envelopeBytes = utf8ByteLength(
            encodeJobPayload({
              text: input || undefined,
              attachment,
              session: sessionId !== null ? { id: sessionId } : undefined,
            }),
          );
          if (envelopeBytes > LIMITS.MAX_ENCRYPTED_INLINE_BYTES) {
            throw new Error(
              'Input is too large once wrapped for sending - shorten the message or use the elisym CLI.',
            );
          }
        }

        // Delegated payment mode: when the card advertises an spl-approve
        // delegation AND this wallet holds an ACTIVE matching allowance
        // covering the advertised price, the buy skips the per-job payment tx
        // entirely - the provider pulls the price from the delegation AFTER
        // delivering. Same button, no extra gate: consent was given at approve.
        // The proof is a wallet `signMessage` over the SAME shared
        // `buildAuthMessage` bytes the SDK signs/verifies (single-use nonce,
        // short expiry), base58-encoded identically.
        const requestedDelegated = buySession.payment === 'delegated';
        let delegatedPayment:
          | { owner: string; expiryUnix: number; nonce: string; proof: string }
          | undefined;
        const delegationDescriptor = card.delegation;
        // `delegationCanWin` carries the USDC-identity and rail-label tests
        // (see where it is computed); the remaining clauses are the narrowing
        // TypeScript needs to use the descriptor and the signer. USDC-only
        // mirrors the provider-side load guard and the MCP gate in
        // `submit_delegated_job` - a delegation block on a card priced in any
        // other asset would compare mismatched subunits and submit a job the
        // provider rejects anyway.
        if (delegationCanWin && delegationDescriptor && publicKey && signMessage) {
          const owner = publicKey.toBase58();
          const price = BigInt(card.payment?.job_price ?? 0);
          let delegationActive = false;
          let delegationReadFailed = false;
          try {
            const ownerAta = await deriveOwnerDelegationAta(owner, SOLANA_CLUSTER);
            const delegationStatus = await getDelegation(kitRpc, ownerAta);
            delegationActive =
              delegationStatus !== null &&
              delegationStatus.delegate === delegationDescriptor.delegate_pubkey &&
              price > 0n &&
              delegationStatus.remainingCap >= price &&
              delegationStatus.balance >= price;
          } catch {
            // RPC failure reading the delegation - fall back to per-job
            // payment (or abort an explicit Use, below).
            delegationReadFailed = true;
          }
          if (requestedDelegated && !delegationActive) {
            // The user clicked Use: surprising them with a per-job payment
            // prompt they did not choose is worse than failing loudly. Drop
            // the cached allowance read the label was painted from - without
            // this the button stays 'Use' (staleness alone never refetches)
            // and every re-click repeats the same error.
            invalidateDelegationStatus(queryClient, owner);
            throw new Error(
              delegationReadFailed
                ? 'Could not verify your delegated allowance (network error) - try again.'
                : 'Your delegated allowance no longer covers this job - top it up in the Delegation tab.',
            );
          }
          if (delegationActive) {
            // Sign OUTSIDE the fallback catch: a user who rejects the
            // authorization aborts the buy (outer catch), rather than being
            // silently re-prompted for a per-job payment they just declined.
            toast.loading('Approve the delegated-payment authorization in your wallet...', {
              id: toastId,
            });
            const expiryUnix = Math.floor(Date.now() / 1000) + MAX_PROOF_TTL_SECS;
            const nonce = mintDelegationNonce();
            const authMessage = buildAuthMessage({
              agentDelegate: delegationDescriptor.delegate_pubkey,
              nostrAuthor: identity.publicKey,
              owner,
              expiryUnix,
              nonce,
            });
            const signatureBytes = await signMessage(authMessage);
            const proof = getBase58Decoder().decode(signatureBytes);
            delegatedPayment = { owner, expiryUnix, nonce, proof };
            // No payment-required quote will ever arrive on the delegated
            // path, so the deferred input upload must happen NOW, pre-submit -
            // the provider fetches the file right after its own pre-check.
            if (uploadInput) {
              toast.loading('Uploading file...', { id: toastId });
              await retryWithBackoff(uploadInput);
              uploadInput = undefined;
            }
            toast.loading('Submitting delegated job...', { id: toastId });
          }
        } else if (requestedDelegated) {
          // Unreachable from the UI (the Use button only renders with a
          // delegation-advertising card and a connected signMessage-capable
          // wallet) - fail closed rather than silently paying per-job.
          throw new Error('Delegated payment is not available for this job.');
        }

        const jobEventId = await client.marketplace.submitJobRequest(identity, {
          input,
          capability,
          providerPubkey: agentPubkey,
          acceptTransports: WEB_ACCEPT_TRANSPORTS,
          ...(attachment ? { attachment } : {}),
          ...(sessionId !== null ? { sessionId } : {}),
          ...(delegatedPayment ? { delegatedPayment } : {}),
        });
        setSession((prev) =>
          sessionMatches(prev) ? { ...prev, jobId: jobEventId, phase: 'awaiting-provider' } : prev,
        );

        snapshotSaveJob({
          jobEventId,
          agentPubkey,
          agentName,
          agentPicture,
          capability,
          status: 'submitted',
          createdAt: Date.now(),
          // D13: stamp the cluster so the /jobs merge can scope history to
          // the current network (legacy unstamped entries read as devnet).
          network: SOLANA_CLUSTER,
        });

        // Submit-time thread entry (stage 2): pending until an outcome
        // transition completes or fails it. `sessionId` is recorded as given -
        // a UUID for context sends, `null` as the deliberate one-shot marker.
        const cardAsset = paymentToAsset(card.payment);
        await appendPendingEntry(agentPubkey, {
          jobEventId,
          customerPubkey: identityPubkey,
          sessionId,
          capability,
          prompt: input,
          ...(attachment ? { promptAttachment: attachment } : {}),
          ...(card.payment?.job_price !== undefined
            ? { priceLamports: card.payment.job_price }
            : {}),
          ...(cardAsset ? { asset: cardAsset } : {}),
          ts: Date.now(),
        });
        threadEntryJobEventId = jobEventId;
        if (file) {
          rememberJobFile(jobEventId, file);
        }
        // The pending entry is now the durable in-flight signal - release the
        // token AFTER the entry lands so there is no zero-signal window.
        await releaseSessionToken();

        // Completes the thread entry and, when the completion transition
        // actually fired for a UUID-carrying entry, bumps the active session's
        // completedCount (current-id match enforced inside recordCompletion).
        // Sequential awaits keep the thread-store and chat-session lock
        // families from ever being held simultaneously.
        const settleThreadCompletion = async (
          resultText: string,
          attachments: FileAttachment[],
        ) => {
          const fired = await completeEntry(agentPubkey, jobEventId, {
            result: resultText,
            ...(attachments.length > 0 ? { resultAttachments: attachments } : {}),
          });
          if (fired && typeof sessionId === 'string') {
            await recordCompletion(identityPubkey, agentPubkey, sessionId);
          }
        };

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
              // A delegated job never pays per-job: the provider settles by
              // pulling from the delegation after delivering. A rogue
              // payment-required on this path is out-of-protocol - ignore it
              // (a real rejection arrives as error feedback instead).
              if (delegatedPayment !== undefined) {
                return;
              }
              if (status !== 'payment-required' || !paymentRequestJson) {
                return;
              }
              if (!publicKey) {
                // Dismiss-then-toast, not a same-id swap - see the sonner
                // spinner-stick note in onError below.
                toast.dismiss(toastId);
                toast.error('Wallet disconnected - reconnect and retry');
                setSession((prev) => (sessionMatches(prev) ? { ...prev, buying: false } : prev));
                // Terminal, unpaid exit: the job will never be paid, so the
                // pending entry gains the Retry affordance now instead of
                // waiting out the 24h unpaid-aging rule.
                void failEntry(agentPubkey, jobEventId);
                cleanupRef.current?.();
                cleanupRef.current = null;
                return;
              }

              // Synchronous double-payment guard - must run before the first await.
              if (paymentInitiated) {
                return;
              }
              paymentInitiated = true;
              setSession((prev) => (sessionMatches(prev) ? { ...prev, phase: 'paying' } : prev));

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

                const protocolConfig = await getProtocolConfig(
                  kitRpc,
                  PROTOCOL_PROGRAM_ID,
                  SOLANA_CLUSTER,
                );

                // Bound the charge to the advertised price (subunits). Without
                // this a malicious provider can inflate `paymentRequest.amount`
                // after the customer committed (bait-and-switch). A card with no
                // advertised price (free, or a `payment` block lacking `job_price`)
                // is bounded to 0 - so a "free" card that then demands payment is
                // rejected rather than left unbounded. `job_price` is an integer
                // subunit value; coerce via BigInt with no float math.
                const maxAmountLamports = BigInt(card.payment?.job_price ?? 0);

                // The customer network is the page's cluster (D7): a request
                // settling on the other cluster fails with `network_mismatch`
                // before any transaction is built.
                const validationError = payment.validatePaymentRequest(
                  paymentRequestJson,
                  { feeBps: protocolConfig.feeBps, treasury: protocolConfig.treasury },
                  SOLANA_CLUSTER,
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

                // Per-network membership guard: a registry-known SPL asset whose
                // mint does not exist on this page's cluster (LSM on devnet; the
                // other network's USDC) is unpayable here. A hostile
                // devnet-tagged card can claim such an asset and pass both the
                // network gate above and the card-vs-request equality, so refuse
                // before asking the wallet to sign rather than failing in
                // on-chain simulation. Mirrors the MCP pay paths.
                if (
                  requestMint !== undefined &&
                  !splAssetsForNetwork(SOLANA_CLUSTER).some(
                    (networkAsset) => networkAsset.mint === requestMint,
                  )
                ) {
                  throw new Error(
                    `Payment asset is not available on ${SOLANA_CLUSTER} (mint ${requestMint}). ` +
                      'Refusing to proceed.',
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
                // never discarded and can be reconciled from history. The charge fields
                // ride the same write: this is the only point where a charge is certain
                // AND `paymentRequest` is in scope - a resumable-paid job recovered by
                // the poller never reaches the post-confirmation update, so stamping
                // there would leave it amount-less forever.
                const chargedAsset = resolveKnownAsset(
                  paymentRequest.asset?.chain ?? 'solana',
                  paymentRequest.asset?.token ?? 'sol',
                  paymentRequest.asset?.mint,
                );
                snapshotUpdateJob(jobEventId, {
                  txHash: signature,
                  // Always resolvable in practice - an unknown asset cannot pass
                  // validatePaymentRequest above; the guard is honest typing.
                  ...(chargedAsset !== undefined
                    ? { paymentAmount: paymentRequest.amount, assetKey: assetKey(chargedAsset) }
                    : {}),
                });
                // Same rule for the thread entry: a paid `pending` entry (txHash
                // present) is exempt from unpaid-aging and trimming - money was
                // sent, the state must stay visible.
                void recordEntryTxHash(agentPubkey, jobEventId, signature);
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

                // `paymentAmount` is NOT written here: the broadcast point above is
                // the only amount writer (the feedback-advertised `amount` may be
                // undefined/0 and would clobber the real charge). If a provider
                // error feedback flipped the row terminal mid-confirm, the store's
                // sticky-terminal guard keeps `error` and only the txHash lands -
                // accepted: the job did fail as far as anyone knows, and should the
                // provider crash-recover and complete it later, the /jobs merge
                // folds the relay-side success over the local row for display.
                snapshotUpdateJob(jobEventId, {
                  status: 'payment-completed',
                  txHash: signature,
                });
                paidLocally = true;
                setSession((prev) =>
                  sessionMatches(prev)
                    ? { ...prev, paid: true, txHash: signature, phase: 'processing' }
                    : prev,
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
                // The charge fields stamped at broadcast go with it: a reverted job
                // must not display a charge. The cleanup rides `updateJob`, NOT the
                // flip: a provider error feedback can flip this row terminal while
                // confirmTransaction is in flight, and flipTerminal's guard would then
                // drop the whole patch, leaving the reverted signature persisted.
                if (err instanceof PaymentRevertedError) {
                  snapshotUpdateJob(jobEventId, {
                    txHash: undefined,
                    paymentAmount: undefined,
                    assetKey: undefined,
                  });
                }
                snapshotFlipJob(
                  jobEventId,
                  { status: 'error' },
                  { stampUnseen: !agentPageInView(agentPubkey) },
                );
                // Terminal payment failure (never broadcast, or reverted with no
                // funds moved): the thread entry gains the Retry affordance. The
                // resumable branch above deliberately leaves it paid-`pending`.
                void failEntry(agentPubkey, jobEventId);
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
              _eventId: string,
              _attachment?: FileAttachment,
              attachments?: FileAttachment[],
              paymentTx?: string,
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
              // Delegated jobs settle at delivery: the result event carries the
              // provider's pull signature (transparency data - the on-chain
              // delegation remains the truth).
              const delegatedTxHash =
                delegatedPayment !== undefined && paymentTx !== undefined ? paymentTx : undefined;
              const alreadyOnAgentPage = agentPageInView(agentPubkey);
              if (delegatedTxHash !== undefined) {
                // Unconditional stamp: if the /jobs merge in another tab or the
                // poller already flipped this row terminal, flipTerminal's guard
                // would drop the whole patch and the settlement signature would
                // never reach wallet history (the rating's payment proof).
                snapshotUpdateJob(jobEventId, { txHash: delegatedTxHash });
              }
              snapshotFlipJob(
                jobEventId,
                { status: 'completed', result },
                { stampUnseen: !alreadyOnAgentPage },
              );
              if (delegatedTxHash !== undefined) {
                void recordEntryTxHash(agentPubkey, jobEventId, delegatedTxHash);
              }
              if (delegatedPayment !== undefined) {
                // The provider's pull reduced the remaining allowance - drop
                // the cached read so Use/Delegate buttons recompute.
                invalidateDelegationStatus(queryClient, delegatedPayment.owner);
                // A pull on that same ATA is how this rail settles, so the
                // balance the buy gate reads is stale as soon as the job
                // lands. This is the one balance-moving purchase the app makes
                // without signing a transfer of its own, so nothing else
                // refreshes it; invalidating unconditionally costs at most one
                // refetch when the provider delivered without charging.
                invalidateWalletBalances(queryClient, delegatedPayment.owner);
              }
              void settleThreadCompletion(result, resultAttachments);
              setSession((prev) =>
                sessionMatches(prev)
                  ? {
                      ...prev,
                      buying: false,
                      pending: false,
                      result,
                      resultAttachments,
                      resultProviderPubkey,
                      ...(delegatedPayment !== undefined
                        ? { paid: true, ...(delegatedTxHash ? { txHash: delegatedTxHash } : {}) }
                        : {}),
                    }
                  : prev,
              );
              cleanupRef.current = null;
              const agentPath = `/agent/${agentPubkey}`;
              // Dismiss-then-toast, not a same-id swap - see the sonner
              // spinner-stick note in onError below.
              toast.dismiss(toastId);
              toast.success(`Result received from ${agentName}`, {
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
              snapshotFlipJob(
                jobEventId,
                { status: 'error' },
                { stampUnseen: !agentPageInView(agentPubkey) },
              );
              // A provider error feedback (incl. "session busy") becomes an
              // ordinary failed bubble with Retry. If the provider completes
              // the job later anyway (crash-recovery re-execution), hydration
              // flips the failed entry back to completed.
              void failEntry(agentPubkey, jobEventId);
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
              // nothing settled - surface it as an error. A DELEGATED job has
              // no customer-side payment step at all: the provider may still
              // deliver (and pull) after the window, so it takes the pending
              // path too.
              if (!paidLocally && delegatedPayment === undefined) {
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
                snapshotFlipJob(
                  jobEventId,
                  { status: 'error' },
                  { stampUnseen: !agentPageInView(agentPubkey) },
                );
                // Unpaid timeout is terminal for the thread entry (the design's
                // aging rule, applied eagerly while the tab is still open). A
                // paid timeout above stays `pending` - money was sent.
                void failEntry(agentPubkey, jobEventId);
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
        // A failure before a jobEventId/thread entry exists stays composer-only
        // (nothing was submitted); after the entry landed it becomes a failed
        // bubble with Retry.
        if (threadEntryJobEventId !== null) {
          void failEntry(agentPubkey, threadEntryJobEventId);
        }
        await releaseSessionToken();
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
      signMessage,
      saveJob,
      updateJob,
      flipJob,
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
            // Wallet job history only - deliberately NO thread-store write here:
            // a poller-recovered result reaches the thread via the Chat tab's
            // hydration/reconcile (the stated eventual-consistency window).
            flipJob(
              job.jobEventId,
              { status: 'completed', result },
              { stampUnseen: !agentPageInView(job.agentPubkey) },
            );
            // The job may have settled by a delegated pull that reduced the
            // allowance; the poller has no per-job rail marker, so drop the
            // cached read unconditionally for the connected wallet.
            if (wallet) {
              invalidateDelegationStatus(queryClient, wallet);
            }
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
  }, [wallet, idCtx.identity, client, flipJob, queryClient]);

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
        // The rating never reached the network - roll back the optimistic
        // `rated` stamp so the affordance comes back and a retry stays possible.
        setSession((prev) => (prev && prev.jobId === jobId ? { ...prev, rated: false } : prev));
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
  /**
   * Omitted `session` defaults to a stateless one-shot (`sessionId: null`) -
   * the Products-tab rule. Chat sends resolve a session first and pass it.
   */
  buy: (input?: string, file?: File, session?: BuySessionOptions) => Promise<void>;
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
    async (input = '', file?: File, buySession: BuySessionOptions = { sessionId: null }) => {
      if (!card) {
        return;
      }
      await globalBuy({ agentPubkey, agentName, agentPicture, card }, input, file, buySession);
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
