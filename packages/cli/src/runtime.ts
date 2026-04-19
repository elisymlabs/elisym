/**
 * AgentRuntime - main job processing loop with concurrency, payment, and recovery.
 * Supports per-capability pricing: each capability can have a different price.
 */
import {
  SolanaPaymentStrategy,
  calculateProtocolFee,
  createSlidingWindowLimiter,
  getProtocolConfig,
  getProtocolProgramId,
  LIMITS,
} from '@elisym/sdk';
import type { ProtocolConfigInput, SlidingWindowLimiter } from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import pLimit from 'p-limit';
import { getRpcUrl } from './helpers.js';
import { JobLedger } from './ledger.js';
import type { SkillRegistry, SkillContext } from './skill';
import type { NostrTransport, IncomingJob } from './transport/nostr.js';

const payment = new SolanaPaymentStrategy();
const LEDGER_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirrors plugin
const TOTAL_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface RuntimeConfig {
  paymentTimeoutSecs: number;
  maxConcurrentJobs: number;
  recoveryMaxRetries: number;
  recoveryIntervalSecs: number;
  network: string;
  solanaAddress?: string;
  maxQueueSize?: number;
}

export interface RuntimeCallbacks {
  onJobReceived?: (job: IncomingJob) => void;
  onJobCompleted?: (jobId: string, result: string) => void;
  onJobError?: (jobId: string, error: string) => void;
  onPaymentReceived?: (jobId: string, netAmount: number) => void;
  onLog?: (message: string) => void;
  /**
   * Invoked at the start of `stop()`, before the abort signal fires and before
   * the transport is torn down, so callers can tear down external resources
   * (watchdogs, heartbeats, ping subscriptions) that live outside the runtime.
   *
   * Contract:
   * - Runs exactly once per runtime - `stop()` is idempotent; repeated calls
   *   do not re-invoke this callback.
   * - Thrown errors are caught and logged via `onLog`; shutdown continues.
   * - At invocation time the transport and abort controller are still live;
   *   callers can safely use transport-backed services for final operations.
   */
  onStop?: () => void;
}

/** Resolve the price for a job by matching its tags against registered skills. */
function resolveJobPrice(tags: string[], skills: SkillRegistry): number {
  const skill = skills.route(tags);
  return skill?.priceLamports ?? 0;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_JOBS_PER_CUSTOMER = 20;
const GLOBAL_MAX_JOBS_PER_WINDOW = 200;
const MAX_TRACKED_CUSTOMERS = 1000;
const GLOBAL_LIMITER_KEY = '__global__';

export class AgentRuntime {
  private limit: ReturnType<typeof pLimit>;
  private inFlight = new Set<string>();
  private pending = 0;
  private maxQueueSize: number;
  private abortController = new AbortController();
  private jobAbortControllers = new Set<AbortController>();
  private recoveryInterval: ReturnType<typeof setInterval> | null = null;
  private gcInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Per-customer sliding-window rate limiter (keyed on customer pubkey). */
  private customerLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: MAX_JOBS_PER_CUSTOMER,
    maxKeys: MAX_TRACKED_CUSTOMERS,
  });
  /** Global sliding-window rate limiter (Sybil protection). */
  private globalLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: GLOBAL_MAX_JOBS_PER_WINDOW,
    maxKeys: 1,
  });

  constructor(
    private transport: NostrTransport,
    private skills: SkillRegistry,
    private skillCtx: SkillContext,
    private config: RuntimeConfig,
    private ledger: JobLedger,
    private callbacks: RuntimeCallbacks = {},
  ) {
    this.limit = pLimit(config.maxConcurrentJobs);
    this.maxQueueSize = config.maxQueueSize ?? config.maxConcurrentJobs * 10;
  }

  /** Fetch on-chain protocol config (fee, treasury). Always fetches fresh to avoid stale treasury. */
  private async fetchProtocolConfig(): Promise<ProtocolConfigInput> {
    // Only devnet is supported until the elisym-config program ships on mainnet;
    // agent configs pinned to other networks must be re-initialized explicitly.
    if (this.config.network !== 'devnet') {
      throw new Error(
        `Network "${this.config.network}" is not supported. Only "devnet" is available ` +
          `until the on-chain protocol program is deployed on mainnet.`,
      );
    }
    const programId = getProtocolProgramId('devnet');
    const rpc = createSolanaRpc(getRpcUrl(this.config.network));
    const config = await getProtocolConfig(rpc, programId, { forceRefresh: true });
    return { feeBps: config.feeBps, treasury: config.treasury };
  }

  async run(): Promise<void> {
    const log = this.callbacks.onLog ?? console.log;

    // Prune terminal ledger entries past the 30-day retention window.
    this.ledger.pruneOldEntries(LEDGER_RETENTION_MS);

    // Recover pending jobs from previous sessions
    await this.recoverPendingJobs();

    // Start periodic recovery
    this.recoveryInterval = setInterval(
      () => this.recoverPendingJobs().catch((e) => log(`Recovery error: ${e}`)),
      this.config.recoveryIntervalSecs * 1000,
    );

    // Periodic ledger GC, rate limit cleanup, and subscription health check
    this.gcInterval = setInterval(() => {
      try {
        this.ledger.pruneOldEntries(LEDGER_RETENTION_MS);
      } catch (e: any) {
        log(`GC error: ${e.message}`);
      }
      this.cleanupRateLimits();
      if (!this.transport.isHealthy()) {
        log('Warning: no events received in 30+ minutes. Check relay connectivity.');
      }
    }, LEDGER_GC_INTERVAL_MS);

    // Start listening for jobs
    this.transport.start((job) => {
      if (this.abortController.signal.aborted) {
        return;
      }
      if (this.inFlight.has(job.jobId)) {
        return;
      }
      if (this.ledger.getStatus(job.jobId)) {
        return;
      }

      // Drop jobs when queue is full to prevent unbounded memory growth
      if (this.pending >= this.maxQueueSize) {
        this.transport
          .sendFeedback(job, { type: 'error', message: 'Server overloaded, try again later' })
          .catch(() => {});
        return;
      }

      // Per-customer check first so a rate-limited customer does not
      // bump the global counter - otherwise a single abusive customer
      // could starve every other caller up to the global cap.
      if (!this.customerLimiter.peek(job.customerId).allowed) {
        this.transport
          .sendFeedback(job, { type: 'error', message: 'Rate limited, try again later' })
          .catch(() => {});
        return;
      }

      // Global rate limiting (Sybil protection).
      if (!this.globalLimiter.peek(GLOBAL_LIMITER_KEY).allowed) {
        this.transport
          .sendFeedback(job, { type: 'error', message: 'Server busy, try again later' })
          .catch(() => {});
        return;
      }

      // Both checks passed - record the hit against both limiters.
      this.customerLimiter.check(job.customerId);
      this.globalLimiter.check(GLOBAL_LIMITER_KEY);

      this.callbacks.onJobReceived?.(job);
      this.inFlight.add(job.jobId);
      this.pending++;

      this.limit(() => this.processJob(job))
        .catch((e: any) => {
          this.callbacks.onJobError?.(job.jobId, e.message);
        })
        .finally(() => {
          this.inFlight.delete(job.jobId);
          this.pending--;
        });
    });

    log('Agent runtime started. Listening for jobs...');

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      this.abortController.signal.addEventListener('abort', () => resolve(), { once: true });

      process.on('SIGINT', () => {
        log('Shutting down...');
        this.stop();
        setTimeout(() => process.exit(0), 3000).unref();
      });
      process.on('SIGTERM', () => {
        log('Shutting down...');
        this.stop();
        setTimeout(() => process.exit(0), 3000).unref();
      });
    });
  }

  /** Drop expired hits from both sliding-window limiters. */
  private cleanupRateLimits(): void {
    this.customerLimiter.prune();
    this.globalLimiter.prune();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    try {
      this.callbacks.onStop?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      (this.callbacks.onLog ?? console.log)(`onStop error: ${msg}`);
    }
    this.abortController.abort();
    for (const controller of this.jobAbortControllers) {
      controller.abort();
    }
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
    this.transport.stop();
  }

  /** Wrapper with total job timeout and error handling. */
  private async processJob(job: IncomingJob): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const jobAbort = new AbortController();
    this.jobAbortControllers.add(jobAbort);
    try {
      await Promise.race([
        this.executeJob(job, jobAbort.signal),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            jobAbort.abort();
            reject(new Error('Job processing timeout'));
          }, TOTAL_JOB_TIMEOUT_MS);
        }),
      ]);
    } catch (e: any) {
      const log = this.callbacks.onLog ?? console.log;
      log(`[${job.jobId.slice(0, 8)}] Error: ${e.message}`);

      // Don't mark executed jobs as failed - recovery will re-deliver
      const currentStatus = this.ledger.getStatus(job.jobId);
      if (currentStatus !== 'executed') {
        this.ledger.markFailed(job.jobId);
      }
      this.callbacks.onJobError?.(job.jobId, e.message);

      // W8: Sanitize error messages before sending to customer
      const safeMessage = e.message?.includes('API')
        ? 'Internal processing error'
        : (e.message ?? 'Unknown error');
      await this.transport
        .sendFeedback(job, { type: 'error', message: safeMessage })
        .catch(() => {});
    } finally {
      clearTimeout(timeoutId);
      this.jobAbortControllers.delete(jobAbort);
    }
  }

  /** Core job processing logic - payment, skill execution, result delivery. */
  private async executeJob(job: IncomingJob, signal?: AbortSignal): Promise<void> {
    const log = this.callbacks.onLog ?? console.log;

    // W2: Validate input length before processing
    if (job.input.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(`Input too long: ${job.input.length} chars (max ${LIMITS.MAX_INPUT_LENGTH})`);
    }

    // ── Step 1: Resolve per-capability price and collect payment ──
    const jobPrice = resolveJobPrice(job.tags, this.skills);
    let netAmount: number | undefined;
    let paymentRequest: string | undefined;

    // W1: Record in ledger BEFORE payment to prevent crash window data loss
    this.ledger.recordPaid({
      job_id: job.jobId,
      input: job.input,
      input_type: job.inputType,
      tags: job.tags,
      customer_id: job.customerId,
      bid: job.bid,
      net_amount: undefined,
      raw_event_json: JSON.stringify(job.rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    if (jobPrice > 0) {
      const result = await this.collectPayment(job, jobPrice, signal);
      netAmount = result.netAmount;
      paymentRequest = result.paymentRequest;
      // Update ledger with payment info
      this.ledger.updatePayment(job.jobId, netAmount, paymentRequest);
      log(`[${job.jobId.slice(0, 8)}] Payment confirmed: ${netAmount} lamports`);
      this.callbacks.onPaymentReceived?.(job.jobId, netAmount);
    }

    // ── Step 2: Send Processing feedback ──
    await this.transport.sendFeedback(job, { type: 'processing' }).catch(() => {});

    // ── Step 3: Route to skill ──
    const skill = this.skills.route(job.tags);
    if (!skill) {
      throw new Error('No skill matched for tags: ' + job.tags.join(', '));
    }

    log(`[${job.jobId.slice(0, 8)}] Executing skill: ${skill.name}`);

    // ── Step 4: Execute skill ──
    const output = await skill.execute(
      {
        data: job.input,
        inputType: job.inputType,
        tags: job.tags,
        jobId: job.jobId,
      },
      { ...this.skillCtx, signal },
    );

    // ── Step 5: Cache result in ledger ──
    // NOTE: At-least-once delivery. A crash between execute() return and markExecuted()
    // flush leaves the job as 'paid' - recovery will re-execute. Skills must be idempotent
    // or tolerant of re-execution.
    this.ledger.markExecuted(job.jobId, output.data);
    log(`[${job.jobId.slice(0, 8)}] Skill completed, delivering result`);

    // ── Step 6: Deliver result ──
    const eventId = await this.transport.deliverResult(job, output.data, netAmount);
    this.ledger.markDelivered(job.jobId);

    log(`[${job.jobId.slice(0, 8)}] Delivered: ${eventId.slice(0, 16)}...`);
    this.callbacks.onJobCompleted?.(job.jobId, output.data);
  }

  /**
   * Collect payment for a job. Creates payment request, sends PaymentRequired feedback,
   * polls for on-chain confirmation. Aborts if signal fires.
   */
  private async collectPayment(
    job: IncomingJob,
    jobPrice: number,
    signal?: AbortSignal,
  ): Promise<{ netAmount: number; paymentRequest: string }> {
    const log = this.callbacks.onLog ?? console.log;

    if (!this.config.solanaAddress) {
      throw new Error('Solana address not configured');
    }

    const protocolConfig = await this.fetchProtocolConfig();

    // Create payment request with protocol fee
    const request = payment.createPaymentRequest(
      this.config.solanaAddress,
      jobPrice,
      protocolConfig,
      { expirySecs: this.config.paymentTimeoutSecs },
    );
    const requestJson = JSON.stringify(request);

    const fee = calculateProtocolFee(jobPrice, protocolConfig.feeBps);
    const netAmount = jobPrice - fee;

    log(`[${job.jobId.slice(0, 8)}] Payment required: ${jobPrice} lamports (fee: ${fee})`);

    // Store payment request reference early for crash recovery
    this.ledger.updatePayment(job.jobId, undefined, requestJson);

    // Send PaymentRequired feedback to customer
    await this.transport.sendFeedback(job, {
      type: 'payment-required',
      amount: jobPrice,
      paymentRequest: requestJson,
      chain: 'solana',
    });

    // Verify payment on-chain (SDK defaults: 15 retries, 2s interval = 30s window)
    const rpc = createSolanaRpc(getRpcUrl(this.config.network));

    // Wrap with abort signal since SDK doesn't accept one natively
    let result: { verified: boolean };
    if (signal) {
      let abortHandler: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        abortHandler = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      });
      try {
        result = await Promise.race([
          payment.verifyPayment(rpc, request, protocolConfig),
          abortPromise,
        ]);
      } finally {
        if (abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    } else {
      result = await payment.verifyPayment(rpc, request, protocolConfig);
    }

    if (result.verified) {
      return { netAmount, paymentRequest: requestJson };
    }

    // Timeout - customer may have paid on-chain but verification failed
    log(
      `[${job.jobId.slice(0, 8)}] WARNING: Payment verification timed out. ` +
        `Customer may have paid on-chain. Check address ${this.config.solanaAddress} manually.`,
    );
    await this.transport
      .sendFeedback(job, { type: 'error', message: 'payment timeout' })
      .catch(() => {});
    throw new Error('Payment timeout');
  }

  private async recoverPendingJobs(): Promise<void> {
    const pending = this.ledger.pendingJobs().filter((e) => !this.inFlight.has(e.job_id));
    if (pending.length === 0) {
      return;
    }

    const log = this.callbacks.onLog ?? console.log;
    log(`Recovering ${pending.length} pending jobs...`);

    for (const entry of pending) {
      if (entry.retry_count >= this.config.recoveryMaxRetries) {
        this.ledger.markFailed(entry.job_id);
        // Notify customer of permanent failure
        if (entry.raw_event_json) {
          try {
            const rawEvent = JSON.parse(entry.raw_event_json);
            await this.transport
              .sendFeedback(
                {
                  jobId: entry.job_id,
                  input: entry.input,
                  inputType: entry.input_type,
                  tags: entry.tags,
                  customerId: entry.customer_id,
                  encrypted: false,
                  rawEvent,
                },
                { type: 'error', message: 'Job permanently failed after maximum retries' },
              )
              .catch(() => {});
          } catch {
            /* best effort */
          }
        }
        continue;
      }

      if (!entry.raw_event_json) {
        continue;
      }

      // Respect queue limit for recovery jobs too
      if (this.pending >= this.maxQueueSize) {
        break;
      }

      // Route through p-limit to respect maxConcurrentJobs
      this.inFlight.add(entry.job_id);
      this.pending++;
      this.limit(async () => {
        try {
          await this.recoverSingleJob(entry, log);
        } catch (e: any) {
          log(`[${entry.job_id.slice(0, 8)}] Recovery: failed: ${e.message}`);
        } finally {
          this.inFlight.delete(entry.job_id);
          this.pending--;
        }
      });
    }
  }

  private async recoverSingleJob(
    entry: ReturnType<JobLedger['pendingJobs']>[number],
    log: (msg: string) => void,
  ): Promise<void> {
    const recoveryAbort = new AbortController();
    this.jobAbortControllers.add(recoveryAbort);
    const timeout = setTimeout(() => recoveryAbort.abort(), TOTAL_JOB_TIMEOUT_MS);

    try {
      this.ledger.incrementRetry(entry.job_id);
      const rawEvent = JSON.parse(entry.raw_event_json!);
      const fakeJob: IncomingJob = {
        jobId: entry.job_id,
        input: entry.input,
        inputType: entry.input_type,
        tags: entry.tags,
        customerId: entry.customer_id,
        encrypted: false,
        rawEvent,
      };

      if (entry.status === 'executed' && entry.result !== undefined) {
        // Re-deliver only
        await this.transport.deliverResult(fakeJob, entry.result, entry.net_amount);
        this.ledger.markDelivered(entry.job_id);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: re-delivered`);
      } else if (entry.status === 'paid') {
        const skill = this.skills.route(entry.tags);
        if (!skill) {
          log(`[${entry.job_id.slice(0, 8)}] Recovery: no skill for tags, marking failed`);
          this.ledger.markFailed(entry.job_id);
          return;
        }

        // Re-verify payment if reference was stored but confirmation lost to crash
        if (skill.priceLamports > 0 && !entry.net_amount) {
          if (entry.payment_request) {
            const verified = await this.reVerifyPayment(
              entry,
              skill.priceLamports,
              log,
              recoveryAbort.signal,
            );
            if (!verified) {
              this.ledger.markFailed(entry.job_id);
              return;
            }
          } else {
            log(`[${entry.job_id.slice(0, 8)}] Recovery: payment not confirmed, marking failed`);
            this.ledger.markFailed(entry.job_id);
            return;
          }
        }

        const output = await skill.execute(
          {
            data: entry.input,
            inputType: entry.input_type,
            tags: entry.tags,
            jobId: entry.job_id,
          },
          { ...this.skillCtx, signal: recoveryAbort.signal },
        );

        this.ledger.markExecuted(entry.job_id, output.data);
        await this.transport.deliverResult(fakeJob, output.data, entry.net_amount);
        this.ledger.markDelivered(entry.job_id);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: re-executed and delivered`);
      }
    } finally {
      clearTimeout(timeout);
      this.jobAbortControllers.delete(recoveryAbort);
    }
  }

  /**
   * Re-verify an on-chain payment during crash recovery.
   *
   * Limitation: Solana transaction data expires after ~2-3 days (recent blockhash window).
   * If the agent was down longer, a confirmed payment may not be found on-chain and the
   * job will be marked failed. For mainnet: use monitoring, avoid extended downtime, or
   * configure an archive RPC via SOLANA_RPC_URL.
   */
  private async reVerifyPayment(
    entry: ReturnType<JobLedger['pendingJobs']>[number],
    priceLamports: number,
    log: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const request = JSON.parse(entry.payment_request!);
      const rpc = createSolanaRpc(getRpcUrl(this.config.network));
      const protocolConfig = await this.fetchProtocolConfig();

      let result: { verified: boolean };
      if (signal) {
        let abortHandler: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener('abort', abortHandler, { once: true });
        });
        try {
          result = await Promise.race([
            payment.verifyPayment(rpc, request, protocolConfig),
            abortPromise,
          ]);
        } finally {
          if (abortHandler) {
            signal.removeEventListener('abort', abortHandler);
          }
        }
      } else {
        result = await payment.verifyPayment(rpc, request, protocolConfig);
      }

      if (result.verified) {
        const fee = calculateProtocolFee(priceLamports, protocolConfig.feeBps);
        const netAmount = priceLamports - fee;
        this.ledger.updatePayment(entry.job_id, netAmount, entry.payment_request);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: payment re-verified (${netAmount} lamports)`);
        return true;
      }
      log(`[${entry.job_id.slice(0, 8)}] Recovery: payment not found on-chain, marking failed`);
      return false;
    } catch (e: any) {
      log(`[${entry.job_id.slice(0, 8)}] Recovery: payment re-verification error: ${e.message}`);
      return false;
    }
  }
}
