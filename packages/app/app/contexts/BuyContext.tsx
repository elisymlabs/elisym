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
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import { invalidateWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { SDK_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { cacheSet } from '~/lib/localCache';

const COMPUTE_UNIT_LIMIT = 200_000;
const PRIORITY_FEE_PERCENTILE = 75;
const PROTOCOL_PROGRAM_ID = getProtocolProgramId(SDK_CLUSTER);
const kitRpc = createSolanaRpc(SOLANA_RPC_URL);
const payment = new SolanaPaymentStrategy();

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
): Promise<VersionedTransaction> {
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
  return VersionedTransaction.deserialize(wireBytes);
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
  lastInput: string;
  rated: boolean;
}

interface BuyArgs {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  card: CapabilityCard;
}

interface BuyCtx {
  session: ActiveBuySession | null;
  buy: (args: BuyArgs, input: string) => Promise<void>;
  rate: (positive: boolean) => Promise<void>;
}

const Ctx = createContext<BuyCtx | null>(null);

export function BuyProvider({ children }: { children: ReactNode }) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const wallet = publicKey?.toBase58() ?? '';
  const { saveJob, updateJob } = useJobHistory({ wallet });

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
    async (args: BuyArgs, input: string) => {
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
        lastInput: input,
        rated: false,
      });

      const toastId = toast.loading('Submitting job...');

      try {
        const identity = idCtx.identity;
        const capability = toDTag(cardName);

        const jobEventId = await client.marketplace.submitJobRequest(identity, {
          input,
          capability,
          providerPubkey: agentPubkey,
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

              try {
                const protocolConfig = await getProtocolConfig(kitRpc, PROTOCOL_PROGRAM_ID);

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
                  jobEventId,
                );
                const signature = await sendTransaction(versionedTx, connection);
                await connection.confirmTransaction(signature, 'confirmed');
                invalidateWalletBalances(queryClient, publicKey.toBase58());

                await retryWithBackoff(() =>
                  client.marketplace.submitPaymentConfirmation(
                    identity,
                    jobEventId,
                    agentPubkey,
                    signature,
                  ),
                );

                snapshotUpdateJob(jobEventId, {
                  status: 'payment-completed',
                  paymentAmount: amount,
                  txHash: signature,
                });

                toast.loading('Payment sent, waiting for result...', { id: toastId });
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Payment failed';
                snapshotUpdateJob(jobEventId, { status: 'error' });
                setSession((prev) =>
                  sessionMatches(prev) ? { ...prev, buying: false, error: msg } : prev,
                );
                cleanupRef.current?.();
                cleanupRef.current = null;
                toast.error(msg, { id: toastId });
              }
            },

            onResult: (content: string, eventId: string) => {
              snapshotUpdateJob(jobEventId, { status: 'completed', result: content });
              cacheSet(`purchase:${jobEventId}`, {
                result: content,
                eventId,
                receivedAt: Date.now(),
              });
              setSession((prev) =>
                sessionMatches(prev) ? { ...prev, buying: false, result: content } : prev,
              );
              cleanupRef.current = null;
              toast.success('Result received!', { id: toastId });
            },

            onError: (errMsg: string) => {
              snapshotUpdateJob(jobEventId, { status: 'error' });
              setSession((prev) =>
                sessionMatches(prev) ? { ...prev, buying: false, error: errMsg } : prev,
              );
              cleanupRef.current = null;
              toast.error(errMsg, { id: toastId });
            },
          },
          timeoutMs: 120_000,
          customerSecretKey: identity.secretKey,
        });

        cleanupRef.current = cleanup;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to submit job';
        setSession((prev) =>
          sessionMatches(prev) ? { ...prev, buying: false, error: msg } : prev,
        );
        cleanupRef.current = null;
        toast.error(msg, { id: toastId });
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
    ],
  );

  const rate = useCallback(
    async (positive: boolean) => {
      if (!session || !session.jobId || session.rated) {
        return;
      }
      const { jobId, agentPubkey, cardName } = session;
      setSession((prev) => (prev ? { ...prev, rated: true } : prev));
      try {
        const identity = idCtx.identity;
        await client.marketplace.submitFeedback(
          identity,
          jobId,
          agentPubkey,
          positive,
          toDTag(cardName),
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
  buy: (input?: string) => Promise<void>;
  buying: boolean;
  result: string | null;
  error: string | null;
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
    async (input = '') => {
      if (!card) {
        return;
      }
      await globalBuy({ agentPubkey, agentName, agentPicture, card }, input);
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
    error: matches ? (session?.error ?? null) : null,
    jobId: matches ? (session?.jobId ?? null) : null,
    rate,
    rated: matches ? (session?.rated ?? false) : false,
    lastInput: matches ? (session?.lastInput ?? '') : '',
  };
}
