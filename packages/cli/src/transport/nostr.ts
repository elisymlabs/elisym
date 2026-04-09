/**
 * NostrTransport - listens for targeted jobs on Nostr relays, delivers results.
 * Handles NIP-44 decryption, dedup, and retried delivery.
 */
import { BoundedSet, jobRequestKind } from '@elisym/sdk';
import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import type { Event } from 'nostr-tools';

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

  constructor(
    private client: ElisymClient,
    private identity: ElisymIdentity,
    private kindOffsets: number[],
  ) {}

  /** Start listening for targeted job requests. Decrypts NIP-44 content. */
  start(onJob: (job: IncomingJob) => void): void {
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
}
