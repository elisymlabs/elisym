import { finalizeEvent, verifyEvent, type Filter, type Event } from 'nostr-tools';
import {
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT_BASE,
  DEFAULT_KIND_OFFSET,
  DEFAULTS,
  LIMITS,
  jobRequestKind,
  jobResultKind,
} from '../constants';
import { assertLamports } from '../payment/fee';
import { parsePaymentRequest } from '../payment/schema';
import { nip44Encrypt, nip44Decrypt } from '../primitives/crypto';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type {
  Job,
  JobStatus,
  PaymentAssetRef,
  SubCloser,
  SubmitJobOptions,
  JobSubscriptionOptions,
} from '../types';

function isEncrypted(event: Event): boolean {
  return event.tags.some((t) => t[0] === 'encrypted' && t[1] === 'nip44');
}

function resolveRequestId(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === 'e')?.[1];
}

function safeParseInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

const VALID_JOB_STATUSES = new Set<string>([
  'payment-required',
  'payment-completed',
  'processing',
  'error',
  'success',
  'partial',
]);

function toJobStatus(raw: string): JobStatus {
  return VALID_JOB_STATUSES.has(raw) ? (raw as JobStatus) : 'unknown';
}

export class MarketplaceService {
  constructor(private pool: NostrPool) {}

  /** Submit a job request with NIP-44 encrypted input. Returns the event ID. */
  async submitJobRequest(identity: ElisymIdentity, options: SubmitJobOptions): Promise<string> {
    if (!options.input) {
      throw new Error('Job input must not be empty.');
    }
    if (options.input.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `Job input too long: ${options.input.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }
    if (!options.capability || options.capability.length > LIMITS.MAX_CAPABILITY_LENGTH) {
      throw new Error(`Invalid capability: must be 1-${LIMITS.MAX_CAPABILITY_LENGTH} characters.`);
    }
    if (options.providerPubkey && !/^[0-9a-f]{64}$/.test(options.providerPubkey)) {
      throw new Error('Invalid provider pubkey: expected 64 hex characters.');
    }
    const plaintext = options.input;
    const encrypted = options.providerPubkey
      ? nip44Encrypt(plaintext, identity.secretKey, options.providerPubkey)
      : plaintext;

    const tags: string[][] = [
      ['i', options.providerPubkey ? 'encrypted' : 'text', 'text'],
      ['t', options.capability],
      ['t', 'elisym'],
      ['output', 'text/plain'],
    ];

    if (options.providerPubkey) {
      tags.push(['p', options.providerPubkey]);
      tags.push(['encrypted', 'nip44']);
    }

    const kind = jobRequestKind(options.kindOffset ?? DEFAULT_KIND_OFFSET);
    const event = finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encrypted,
      },
      identity.secretKey,
    );

    await this.pool.publish(event);
    return event.id;
  }

  /**
   * Subscribe to job updates (feedback + results) for a given job.
   * Creates 3 subscriptions per call (feedback, result by #e, result by #p+#e)
   * to cover different relay indexing strategies. Returns a cleanup function.
   */
  subscribeToJobUpdates(options: JobSubscriptionOptions): () => void {
    const {
      jobEventId: jid,
      providerPubkey: provPk,
      customerPublicKey: custPk,
      callbacks: cb,
      timeoutMs = DEFAULTS.SUBSCRIPTION_TIMEOUT_MS,
      customerSecretKey: custSk,
      kindOffsets: offsets_,
      sinceOverride: since_,
    } = options;

    const offsets = offsets_ ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    const resultKinds = offsets.map(jobResultKind);
    const since = since_ ?? Math.floor(Date.now() / 1000) - 30;
    const subs: SubCloser[] = [];
    let resolved = false;
    let resultDelivered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      for (const s of subs) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    };

    const decryptResult = (ev: Event): string | null => {
      if (isEncrypted(ev)) {
        if (!custSk) {
          return null;
        }
        try {
          return nip44Decrypt(ev.content, custSk, ev.pubkey);
        } catch {
          return null;
        }
      }
      return ev.content;
    };

    const handleResult = (ev: Event) => {
      if (resolved || resultDelivered) {
        return;
      }
      if (!verifyEvent(ev)) {
        return;
      }
      if (provPk && ev.pubkey !== provPk) {
        return;
      }
      const eTag = ev.tags.find((t) => t[0] === 'e')?.[1];
      if (eTag !== jid) {
        return;
      }
      const content = decryptResult(ev);
      if (content === null) {
        // Skip undecryptable results instead of terminating the subscription.
        // For broadcast jobs a rogue agent could send fake encrypted results;
        // killing the subscription would be a DoS vector.
        return;
      }
      resultDelivered = true;
      try {
        cb.onResult?.(content, ev.id);
      } catch {
        /* caller error - don't crash subscription */
      } finally {
        done();
      }
    };

    try {
      // Feedback subscription
      subs.push(
        this.pool.subscribe(
          {
            kinds: [KIND_JOB_FEEDBACK],
            '#e': [jid],
            since,
          } as Filter,
          (ev) => {
            if (resolved) {
              return;
            }
            if (!verifyEvent(ev)) {
              return;
            }
            if (provPk && ev.pubkey !== provPk) {
              return;
            }
            const eTag = ev.tags.find((t) => t[0] === 'e')?.[1];
            if (eTag !== jid) {
              return;
            }
            const statusTag = ev.tags.find((t) => t[0] === 'status');
            if (statusTag?.[1]) {
              const amtTag = ev.tags.find((t) => t[0] === 'amount');
              const amt = safeParseInt(amtTag?.[1]) ?? 0;
              const paymentReq = amtTag?.[2];
              try {
                cb.onFeedback?.(statusTag[1], amt, paymentReq, ev.pubkey);
              } catch {
                /* caller error - don't crash subscription */
              }
              // For targeted jobs (`provPk` set) an `error` feedback from
              // THE provider is terminal: surface the message via `onError`
              // and close the subscription so the customer doesn't sit
              // waiting until the global timeout. Broadcast jobs (no
              // `provPk`) intentionally keep the subscription open - a
              // single provider's rejection should not silence the others.
              if (provPk && statusTag[1] === 'error' && !resolved) {
                const errorMessage = ev.content?.trim() || 'Provider returned an error';
                done();
                try {
                  cb.onError?.(errorMessage);
                } catch {
                  /* caller error - don't crash subscription */
                }
              }
            }
          },
        ),
      );

      // Result subscription by #e tag
      subs.push(
        this.pool.subscribe(
          {
            kinds: resultKinds,
            '#e': [jid],
            since,
          } as Filter,
          handleResult,
        ),
      );

      // Result subscription by #p tag (customer pubkey) + #e tag
      subs.push(
        this.pool.subscribe(
          {
            kinds: resultKinds,
            '#p': [custPk],
            '#e': [jid],
            since,
          } as Filter,
          handleResult,
        ),
      );
    } catch (err) {
      done();
      throw err;
    }

    timer = setTimeout(() => {
      if (!resolved) {
        done();
        try {
          cb.onError?.(`Timed out waiting for response (${timeoutMs / 1000}s).`);
        } catch {
          /* caller error - don't crash subscription */
        }
      }
    }, timeoutMs);

    return done;
  }

  /** Submit payment confirmation feedback. */
  async submitPaymentConfirmation(
    identity: ElisymIdentity,
    jobEventId: string,
    providerPubkey: string,
    txSignature: string,
  ): Promise<void> {
    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', jobEventId],
          ['p', providerPubkey],
          ['status', 'payment-completed'],
          ['tx', txSignature, 'solana'],
          ['t', 'elisym'],
        ],
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Submit rating feedback for a job. */
  async submitFeedback(
    identity: ElisymIdentity,
    jobEventId: string,
    providerPubkey: string,
    positive: boolean,
    capability?: string,
  ): Promise<void> {
    const tags: string[][] = [
      ['e', jobEventId],
      ['p', providerPubkey],
      ['status', 'success'],
      ['rating', positive ? '1' : '0'],
      ['t', 'elisym'],
    ];
    if (capability) {
      tags.push(['t', capability]);
    }

    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: positive ? 'Good result' : 'Poor result',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  // --- Provider methods ---

  /**
   * Subscribe to incoming job requests for specific kinds.
   * Automatically decrypts NIP-44 encrypted content.
   * Note: decrypted events have modified `content` - do not call `verifyEvent()` on them.
   * Signature verification is performed before decryption.
   */
  subscribeToJobRequests(
    identity: ElisymIdentity,
    kinds: number[],
    onRequest: (event: Event) => void,
  ): SubCloser {
    return this.pool.subscribe(
      {
        kinds,
        '#p': [identity.publicKey],
        '#t': ['elisym'],
        since: Math.floor(Date.now() / 1000) - 5,
      } as Filter,
      (event: Event) => {
        if (!verifyEvent(event)) {
          return;
        }
        if (isEncrypted(event) && event.content) {
          try {
            const decrypted = nip44Decrypt(event.content, identity.secretKey, event.pubkey);
            onRequest({ ...event, content: decrypted });
          } catch {
            // Can't decrypt - skip event (likely not intended for us)
            return;
          }
        } else {
          onRequest(event);
        }
      },
    );
  }

  /** Submit a job result with NIP-44 encrypted content. Result kind is derived from the request kind. */
  async submitJobResult(
    identity: ElisymIdentity,
    requestEvent: Event,
    content: string,
    amount?: number,
  ): Promise<string> {
    if (!content) {
      throw new Error('Job result content must not be empty.');
    }
    if (!Number.isInteger(requestEvent.kind)) {
      throw new Error(`Invalid request event kind: expected integer, got ${requestEvent.kind}.`);
    }
    const offset = requestEvent.kind - KIND_JOB_REQUEST_BASE;
    if (offset < 0 || offset >= 1000) {
      throw new Error(
        `Invalid request event kind ${requestEvent.kind}: expected a NIP-90 job request kind (5000-5999).`,
      );
    }
    const shouldEncrypt = isEncrypted(requestEvent);
    const resultContent = shouldEncrypt
      ? nip44Encrypt(content, identity.secretKey, requestEvent.pubkey)
      : content;
    const resultKind = KIND_JOB_RESULT_BASE + offset;

    const tags: string[][] = [
      ['e', requestEvent.id],
      ['p', requestEvent.pubkey],
      ['t', 'elisym'],
    ];
    if (shouldEncrypt) {
      tags.push(['encrypted', 'nip44']);
    }

    if (amount !== null && amount !== undefined) {
      assertLamports(amount, 'result amount');
      tags.push(['amount', String(amount)]);
    }

    const event = finalizeEvent(
      {
        kind: resultKind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: resultContent,
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }

  /**
   * Submit a job result with retry and exponential backoff.
   * Retries on publish failures (e.g. relay disconnects).
   * With maxAttempts=3: try, ~1s, try, ~2s, try, throw.
   * Jitter: 0.5x-1.0x of calculated delay.
   */
  async submitJobResultWithRetry(
    identity: ElisymIdentity,
    requestEvent: Event,
    content: string,
    amount?: number,
    maxAttempts: number = DEFAULTS.RESULT_RETRY_COUNT,
    baseDelayMs: number = DEFAULTS.RESULT_RETRY_BASE_MS,
  ): Promise<string> {
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.submitJobResult(identity, requestEvent, content, amount);
      } catch (e: unknown) {
        if (attempt >= attempts - 1) {
          throw e;
        }
        // Math.random is fine for jitter - not a security context
        const jitter = 0.5 + Math.random() * 0.5;
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt) * jitter));
      }
    }
    throw new Error('All delivery attempts failed');
  }

  /** Submit payment-required feedback with a payment request. */
  async submitPaymentRequiredFeedback(
    identity: ElisymIdentity,
    requestEvent: Event,
    amount: number,
    paymentRequestJson: string,
  ): Promise<void> {
    assertLamports(amount, 'payment amount');
    if (amount === 0) {
      throw new Error('Invalid payment amount: 0. Must be positive.');
    }
    try {
      JSON.parse(paymentRequestJson);
    } catch {
      throw new Error('Invalid paymentRequestJson: must be valid JSON.');
    }
    if (paymentRequestJson.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `paymentRequestJson too long: ${paymentRequestJson.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }

    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'payment-required'],
          ['amount', String(amount), paymentRequestJson, 'solana'],
          ['t', 'elisym'],
        ],
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Submit processing feedback to notify customer that work has started. */
  async submitProcessingFeedback(identity: ElisymIdentity, requestEvent: Event): Promise<void> {
    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'processing'],
          ['t', 'elisym'],
        ],
        content: '',
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Submit error feedback to notify customer of a failure. */
  async submitErrorFeedback(
    identity: ElisymIdentity,
    requestEvent: Event,
    message: string,
  ): Promise<void> {
    if (!message) {
      throw new Error('Error message must not be empty.');
    }
    if (message.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(
        `Error message too long: ${message.length} chars (max ${LIMITS.MAX_INPUT_LENGTH}).`,
      );
    }
    const event = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', requestEvent.id],
          ['p', requestEvent.pubkey],
          ['status', 'error'],
          ['t', 'elisym'],
        ],
        content: message,
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
  }

  /** Query job results by request IDs and decrypt NIP-44 content. */
  async queryJobResults(
    identity: ElisymIdentity,
    requestIds: string[],
    kindOffsets?: number[],
    providerPubkey?: string,
  ): Promise<
    Map<
      string,
      { content: string; amount?: number; senderPubkey: string; decryptionFailed: boolean }
    >
  > {
    const offsets = kindOffsets ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    const resultKinds = offsets.map(jobResultKind);

    const results = await this.pool.queryBatchedByTag(
      { kinds: resultKinds } as Filter,
      'e',
      requestIds,
    );

    const resultByRequest = new Map<
      string,
      { content: string; amount?: number; senderPubkey: string; decryptionFailed: boolean }
    >();
    const createdAtByRequest = new Map<string, number>();
    for (const r of results) {
      if (!verifyEvent(r)) {
        continue;
      }
      if (providerPubkey && r.pubkey !== providerPubkey) {
        continue;
      }
      const eTag = r.tags.find((t) => t[0] === 'e');
      if (!eTag?.[1]) {
        continue;
      }

      const prevTs = createdAtByRequest.get(eTag[1]) ?? 0;
      if (r.created_at < prevTs) {
        continue;
      }

      const amtTag = r.tags.find((t) => t[0] === 'amount');

      let content = r.content;
      let decryptionFailed = false;
      if (isEncrypted(r)) {
        try {
          content = nip44Decrypt(r.content, identity.secretKey, r.pubkey);
        } catch {
          content = '';
          decryptionFailed = true;
        }
      }

      createdAtByRequest.set(eTag[1], r.created_at);
      resultByRequest.set(eTag[1], {
        content,
        amount: safeParseInt(amtTag?.[1]),
        senderPubkey: r.pubkey,
        decryptionFailed,
      });
    }

    return resultByRequest;
  }

  // --- Query methods ---

  /**
   * Fetch recent jobs from the network.
   * NOTE: Job.result contains raw event content. For encrypted jobs,
   * this will be NIP-44 ciphertext - use queryJobResults() for decryption.
   */
  async fetchRecentJobs(
    agentPubkeys?: Set<string>,
    limit?: number,
    since?: number,
    /** Kind offsets to query (default [100]). */
    kindOffsets?: number[],
  ): Promise<Job[]> {
    const offsets = kindOffsets ?? [DEFAULT_KIND_OFFSET];
    if (offsets.length === 0) {
      throw new Error('kindOffsets must not be empty.');
    }
    const requestKinds = offsets.map(jobRequestKind);
    const resultKinds = offsets.map(jobResultKind);

    const reqFilter: Filter = {
      kinds: requestKinds,
      '#t': ['elisym'],
      ...(limit !== null && limit !== undefined && { limit }),
      ...(since !== null && since !== undefined && { since }),
    };
    const rawRequests = await this.pool.querySync(reqFilter);
    const requests = rawRequests.filter(verifyEvent);

    const requestIds = requests.map((r) => r.id);
    let results: Event[] = [];
    let feedbacks: Event[] = [];

    if (requestIds.length > 0) {
      const [rawResults, rawFeedbacks] = await Promise.all([
        this.pool.queryBatchedByTag({ kinds: resultKinds } as Filter, 'e', requestIds),
        this.pool.queryBatchedByTag({ kinds: [KIND_JOB_FEEDBACK] } as Filter, 'e', requestIds),
      ]);
      results = rawResults.filter(verifyEvent);
      feedbacks = rawFeedbacks.filter(verifyEvent);
    }

    // Build targeted agent map
    const targetedAgentByRequest = new Map<string, string>();
    for (const req of requests) {
      const pTag = req.tags.find((t) => t[0] === 'p');
      if (pTag?.[1]) {
        targetedAgentByRequest.set(req.id, pTag[1]);
      }
    }

    // Index results by request ID (respect targeted agent, keep newest)
    const resultsByRequest = new Map<string, Event>();
    for (const r of results) {
      const reqId = resolveRequestId(r);
      if (!reqId) {
        continue;
      }
      const targeted = targetedAgentByRequest.get(reqId);
      if (targeted && r.pubkey !== targeted) {
        continue;
      }
      const existing = resultsByRequest.get(reqId);
      if (!existing || r.created_at > existing.created_at) {
        resultsByRequest.set(reqId, r);
      }
    }

    const feedbackByRequest = new Map<string, Event>();
    for (const f of feedbacks) {
      const reqId = resolveRequestId(f);
      if (!reqId) {
        continue;
      }
      const targeted = targetedAgentByRequest.get(reqId);
      if (targeted && f.pubkey !== targeted) {
        continue;
      }
      const existing = feedbackByRequest.get(reqId);
      if (!existing || f.created_at > existing.created_at) {
        feedbackByRequest.set(reqId, f);
      }
    }

    // Index all feedbacks by request ID for O(1) lookup
    const feedbacksByRequestId = new Map<string, Event[]>();
    for (const f of feedbacks) {
      const reqId = resolveRequestId(f);
      if (!reqId) {
        continue;
      }
      const arr = feedbacksByRequestId.get(reqId);
      if (arr) {
        arr.push(f);
      } else {
        feedbacksByRequestId.set(reqId, [f]);
      }
    }

    const jobs: Job[] = [];
    for (const req of requests) {
      const result = resultsByRequest.get(req.id);
      const feedback = feedbackByRequest.get(req.id);
      const jobAgentPubkey = result?.pubkey ?? feedback?.pubkey;

      if (agentPubkeys && agentPubkeys.size > 0 && jobAgentPubkey) {
        if (!agentPubkeys.has(jobAgentPubkey)) {
          continue;
        }
      }

      // NIP-90: one capability per job request - take the first non-elisym t tag
      const capability = req.tags.find((t) => t[0] === 't' && t[1] !== 'elisym')?.[1];
      const bid = req.tags.find((t) => t[0] === 'bid')?.[1];

      let status: JobStatus = 'processing';
      let amount: number | undefined;
      let txHash: string | undefined;
      let asset: PaymentAssetRef | undefined;

      if (result) {
        status = 'success';
        const amtTag = result.tags.find((t) => t[0] === 'amount');
        amount = safeParseInt(amtTag?.[1]);
      }

      // Check all feedbacks for tx hash + payment asset (encoded inside the
      // payment-required feedback's amount tag as `[amount, raw, requestJson, chain]`).
      const allFeedbacksForReq = feedbacksByRequestId.get(req.id) ?? [];
      for (const fb of allFeedbacksForReq) {
        const txTag = fb.tags.find((t) => t[0] === 'tx');
        if (txTag?.[1] && !txHash) {
          txHash = txTag[1];
        }
        if (!asset) {
          const amtTag = fb.tags.find((t) => t[0] === 'amount');
          const requestJson = amtTag?.[2];
          if (requestJson) {
            const parsed = parsePaymentRequest(requestJson);
            if (parsed.ok && parsed.data.asset) {
              asset = parsed.data.asset;
            }
          }
        }
      }

      if (feedback) {
        if (!result) {
          const statusTag = feedback.tags.find((t) => t[0] === 'status');
          if (statusTag?.[1]) {
            const isTargeted = targetedAgentByRequest.has(req.id);
            if (statusTag[1] === 'payment-required' && !bid && !isTargeted) {
              // Broadcast job without bid: a provider offered to work, but customer
              // hasn't committed. Keep "processing" because showing "payment-required"
              // would imply the customer chose this provider. The actual payment-required
              // transition happens via subscribeToJobUpdates() in real-time.
            } else {
              status = toJobStatus(statusTag[1]);
            }
          }
        }
        if (!amount) {
          const amtTag = feedback.tags.find((t) => t[0] === 'amount');
          amount = safeParseInt(amtTag?.[1]);
        }
      }

      jobs.push({
        eventId: req.id,
        customer: req.pubkey,
        agentPubkey: jobAgentPubkey,
        capability,
        bid: safeParseInt(bid),
        status,
        result: result?.content,
        resultEventId: result?.id,
        amount,
        txHash,
        asset,
        createdAt: req.created_at,
      });
    }

    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Subscribe to live elisym events (requests, results, feedback). */
  subscribeToEvents(kinds: number[], onEvent: (event: Event) => void): SubCloser {
    return this.pool.subscribe(
      {
        kinds,
        '#t': ['elisym'],
        since: Math.floor(Date.now() / 1000),
      } as Filter,
      (event) => {
        if (!verifyEvent(event)) {
          return;
        }
        onEvent(event);
      },
    );
  }
}
