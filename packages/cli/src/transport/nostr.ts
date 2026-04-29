/**
 * NostrTransport - listens for targeted jobs on Nostr relays, delivers results.
 * Handles NIP-44 decryption, dedup, and retried delivery.
 */
import { BoundedSet, KIND_JOB_FEEDBACK, jobRequestKind } from '@elisym/sdk';
import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import { verifyEvent, type Event, type Filter } from 'nostr-tools';

export interface IncomingJob {
  jobId: string;
  input: string;
  inputType: string;
  tags: string[];
  customerId: string;
  bid?: number;
  encrypted: boolean;
  rawEvent: Event;
}

export type JobFeedbackStatus =
  | { type: 'payment-required'; amount: number; paymentRequest: string; chain: string }
  | { type: 'processing' }
  | { type: 'error'; message: string };

function isEncrypted(event: Event): boolean {
  return event.tags.some((t) => t[0] === 'encrypted' && t[1] === 'nip44');
}

const HEALTH_CHECK_IDLE_MS = 30 * 60 * 1000; // 30 minutes

export class NostrTransport {
  private sub: SubCloser | null = null;
  private seenIds = new BoundedSet<string>(10_000);
  private lastEventAt = Date.now();
  private onJob: ((job: IncomingJob) => void) | null = null;

  constructor(
    private client: ElisymClient,
    private identity: ElisymIdentity,
    private kindOffsets: number[],
  ) {}

  /** Start listening for targeted job requests. Decrypts NIP-44 content. */
  start(onJob: (job: IncomingJob) => void): void {
    this.onJob = onJob;
    // Reset idle clock: a fresh subscription hasn't been idle, even if we're
    // restarting after a pool reset where the last event is long in the past.
    this.lastEventAt = Date.now();
    const kinds = this.kindOffsets.map(jobRequestKind);

    this.sub = this.client.marketplace.subscribeToJobRequests(
      this.identity,
      kinds,
      (event: Event) => {
        this.lastEventAt = Date.now();

        // Dedup via BoundedSet
        if (this.seenIds.has(event.id)) {
          return;
        }
        this.seenIds.add(event.id);

        // Must have elisym tag
        const hasElisym = event.tags.some((t) => t[0] === 't' && t[1] === 'elisym');
        if (!hasElisym) {
          return;
        }

        // Extract tags
        const tags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]!);
        const bidTag = event.tags.find((t) => t[0] === 'bid');
        const encrypted = isEncrypted(event);

        // SDK already decrypts NIP-44 content in subscribeToJobRequests
        const iTag = event.tags.find((t) => t[0] === 'i');
        let inputType = 'text';
        if (iTag?.[2]) {
          inputType = iTag[2];
        }
        const input = encrypted ? event.content : (iTag?.[1] ?? event.content);

        onJob({
          jobId: event.id,
          input,
          inputType,
          tags,
          customerId: event.pubkey,
          bid: bidTag?.[1] ? parseInt(bidTag[1], 10) : undefined,
          encrypted,
          rawEvent: event,
        });
      },
    );
  }

  /**
   * Wait for the customer's `payment-completed` feedback for a specific job
   * and return the on-chain Solana tx signature it carries.
   *
   * The customer publishes this event right after `confirmTransaction(... 'confirmed')`
   * succeeds (see packages/app/app/hooks/useBuyCapability.ts), so receiving it
   * lets the provider verify the payment with a single targeted
   * `getTransaction(sig, commitment: 'confirmed')` call instead of the
   * heavyweight `getSignaturesForAddress(reference)` index lookup. This is
   * dramatically more reliable on the public devnet RPC, which throttles and
   * lags the address index.
   *
   * Resolves with `null` if `signal` aborts or `timeoutMs` elapses before a
   * valid signature arrives. The timeout exists so a customer that disappears
   * after job submission does not hold a `p-limit` slot for the full payment
   * expiry window - without it this path waits forever on the relay.
   */
  waitForPaymentSignature(
    jobId: string,
    customerPubkey: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const filter: Filter = {
        kinds: [KIND_JOB_FEEDBACK],
        '#e': [jobId],
        authors: [customerPubkey],
        '#t': ['elisym'],
        since: Math.floor(Date.now() / 1000) - 5,
      };

      const finish = (sig: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        signal.removeEventListener('abort', onAbort);
        sub.close();
        resolve(sig);
      };

      const sub = this.client.pool.subscribe(filter, (event: Event) => {
        if (settled) {
          return;
        }
        if (!verifyEvent(event)) {
          return;
        }
        const status = event.tags.find((t) => t[0] === 'status')?.[1];
        if (status !== 'payment-completed') {
          return;
        }
        const txTag = event.tags.find((t) => t[0] === 'tx');
        const sig = txTag?.[1];
        const chain = txTag?.[2];
        if (typeof sig !== 'string' || sig.length === 0) {
          return;
        }
        // Chain tag is optional for backwards compatibility, but if present it
        // must be 'solana' - we cannot verify a signature on another chain.
        if (chain !== undefined && chain !== 'solana') {
          return;
        }
        finish(sig);
      });

      const onAbort = () => finish(null);
      const timer =
        timeoutMs !== undefined && timeoutMs > 0 ? setTimeout(() => finish(null), timeoutMs) : null;

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Send job feedback to customer. */
  async sendFeedback(job: IncomingJob, status: JobFeedbackStatus): Promise<void> {
    if (status.type === 'payment-required') {
      await this.client.marketplace.submitPaymentRequiredFeedback(
        this.identity,
        job.rawEvent,
        status.amount,
        status.paymentRequest,
      );
    } else if (status.type === 'processing') {
      await this.client.marketplace.submitProcessingFeedback(this.identity, job.rawEvent);
    } else if (status.type === 'error') {
      await this.client.marketplace.submitErrorFeedback(
        this.identity,
        job.rawEvent,
        status.message,
      );
    }
  }

  /** Deliver result to customer. Retries with exponential backoff via SDK. */
  async deliverResult(
    job: IncomingJob,
    content: string,
    amount?: number,
    retries = 3,
  ): Promise<string> {
    return this.client.marketplace.submitJobResultWithRetry(
      this.identity,
      job.rawEvent,
      content,
      amount,
      retries,
    );
  }

  /** Returns true if an event was received within the given idle window. */
  isHealthy(maxIdleMs = HEALTH_CHECK_IDLE_MS): boolean {
    return Date.now() - this.lastEventAt < maxIdleMs;
  }

  stop(): void {
    this.sub?.close();
    this.sub = null;
  }

  /**
   * Re-create the job subscription using the previously registered callback.
   * Call after `NostrPool.reset()` has torn down the underlying subscriptions.
   * `seenIds` is preserved across restarts (dedup survives reconnect);
   * `lastEventAt` is reset by `start()` so `isHealthy()` does not report
   * stale idleness immediately after a successful recovery.
   */
  restart(): void {
    this.stop();
    if (this.onJob) {
      this.start(this.onJob);
    }
  }
}
