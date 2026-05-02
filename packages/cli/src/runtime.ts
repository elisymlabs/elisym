/**
 * AgentRuntime - main job processing loop with concurrency, payment, and recovery.
 * Supports per-capability pricing: each capability can have a different price.
 */
import {
  NATIVE_SOL,
  SolanaPaymentStrategy,
  calculateProtocolFee,
  createSlidingWindowLimiter,
  formatAssetAmount,
  getProtocolConfig,
  getProtocolProgramId,
  LIMITS,
} from '@elisym/sdk';
import type { Asset, ProtocolConfigInput, SlidingWindowLimiter } from '@elisym/sdk';
import {
  createFreeLlmLimiterSet,
  FREE_LLM_GLOBAL_KEY,
  freeLlmCustomerKey,
  LlmHealthError,
  ScriptBillingExhaustedError,
  type FreeLlmLimiterSet,
  type LlmHealthMonitor,
} from '@elisym/sdk/llm-health';
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
/**
 * Hard cutoff for `paid` jobs that the recovery loop is waiting to
 * re-execute against an unhealthy LLM pair. After this age the customer
 * is given up on, the entry is marked `failed`, and a final error
 * feedback is fired. Without this, an operator who walks away from a
 * billing-exhausted agent leaves the ledger and recovery loop spinning
 * on a job nobody will ever deliver.
 */
const MAX_PAID_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// How long the Nostr-feedback signature path waits for a `payment-completed`
// before giving up. Solana confirmation + wallet signing is single-digit
// seconds in the happy path, so 60s is generous; past that the customer is
// almost certainly not coming back and the slot should be released.
const SIG_PATH_TIMEOUT_MS = 60 * 1000;

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
   * (watchdogs, ping subscriptions) that live outside the runtime.
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
  return skill?.priceSubunits ?? 0;
}

/** Resolve the payment asset the matched skill is denominated in. Defaults to SOL. */
function resolveJobAsset(tags: string[], skills: SkillRegistry): Asset {
  const skill = skills.route(tags);
  return skill?.asset ?? NATIVE_SOL;
}

/**
 * Markers that indicate an LLM provider's HTTP response body is about
 * billing / quota exhaustion rather than something benign. Mirrors the
 * marker sets in `cli/src/llm/providers/{anthropic,openai,openai-compatible}.ts`
 * (kept as a permissive superset so any provider's billing language is
 * detected when classifying mid-job errors). Refactoring to a single
 * shared module is out of scope here - just keep this list in sync.
 */
const BILLING_BODY_MARKERS = ['credit balance', 'billing', 'insufficient', 'insufficient_quota'];

/**
 * Customer-facing message for both the preflight gate (cached
 * billing/invalid signal) and the post-execute path (skill.execute
 * surfaced billing/invalid mid-job). Kept identical between the two so
 * the customer sees a stable string regardless of which side of the
 * health-monitor flip their request landed on. Consumed by the SDK
 * subscription as the `onError` argument.
 */
const AGENT_UNAVAILABLE_MESSAGE = 'Agent temporarily unavailable';

/**
 * Re-thrown by the post-execute catch when the underlying skill failure
 * was a billing / invalid signal that just flipped the health pair to
 * unhealthy. Lets `processJob`'s sanitizer surface a stable
 * customer-facing message instead of the generic "Internal processing
 * error" mask that otherwise hides every "API error: ..." string.
 */
class AgentUnavailableError extends Error {
  constructor() {
    super(AGENT_UNAVAILABLE_MESSAGE);
    this.name = 'AgentUnavailableError';
  }
}

function bodyLooksLikeBilling(body: string): boolean {
  const lower = body.toLowerCase();
  return BILLING_BODY_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Resolve the (provider, model) pair the matched skill depends on for
 * health-monitor gating, or `null` if the skill is not LLM-dependent.
 *
 * For `mode: 'llm'` the pair comes from `resolvedTriple` (computed at
 * startup with agent default + override). For script modes the pair
 * comes from `llmOverride.provider`+`.model` declared in SKILL.md, which
 * is the operator's signal that the script reaches an LLM API under
 * the hood. Either source produces the same (provider, model) string
 * pair the health monitor was registered with in `start.ts`.
 */
function resolveHealthPair(
  skill: import('./skill').Skill | null,
): { provider: string; model: string } | null {
  if (!skill) {
    return null;
  }
  if (skill.mode === 'llm' && skill.resolvedTriple) {
    return {
      provider: skill.resolvedTriple.provider,
      model: skill.resolvedTriple.model,
    };
  }
  if (skill.mode !== 'llm' && skill.llmOverride?.provider && skill.llmOverride?.model) {
    return {
      provider: skill.llmOverride.provider,
      model: skill.llmOverride.model,
    };
  }
  return null;
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
  /**
   * Two-tier limiter applied only to free LLM skills (mode='llm', price=0).
   * Existing per-customer + global limiters above remain in effect for all
   * jobs; this set adds tighter caps to prevent unpaid spam from draining
   * the operator's API key.
   */
  private freeLlmLimiters: FreeLlmLimiterSet = createFreeLlmLimiterSet();

  constructor(
    private transport: NostrTransport,
    private skills: SkillRegistry,
    private skillCtx: SkillContext,
    private config: RuntimeConfig,
    private ledger: JobLedger,
    private callbacks: RuntimeCallbacks = {},
    private healthMonitor?: LlmHealthMonitor,
  ) {
    this.limit = pLimit(config.maxConcurrentJobs);
    this.maxQueueSize = config.maxQueueSize ?? config.maxConcurrentJobs * 10;
  }

  /**
   * Inspect an error thrown by `skill.execute()` and, when it carries a
   * billing/invalid signal from the LLM provider, flip the matching
   * (provider, model) pair to unhealthy via the health monitor. The next
   * job hitting the same pair is then refused at the preflight gate
   * before payment, so customers don't keep paying for jobs that will
   * fail. Recovery happens through the lazy recovery loop.
   *
   * Two error shapes are recognized:
   *
   *   - `ScriptBillingExhaustedError` - thrown by SDK script skills when
   *     the spawned process exits with `SCRIPT_EXIT_BILLING_EXHAUSTED`.
   *     Pair comes from `skill.llmOverride` (operator-declared).
   *
   *   - LLM provider HTTP error from `mode: 'llm'` - bare `Error` whose
   *     message starts with "<Provider> API error: <status> <body>" (the
   *     format every CLI provider currently uses). We classify on status:
   *     402 / 401 / 403 -> mark unhealthy. Body markers (`credit
   *     balance`, `billing`, `insufficient`) catch the 400-on-billing case
   *     Anthropic returns and the 429+`insufficient_quota` case OpenAI
   *     and the openai-compatible providers (xAI/Google/DeepSeek) return.
   *     Pair comes from `skill.resolvedTriple`.
   *
   * Anything else is a transient/skill error and does NOT touch health
   * state - the recovery loop should not be poisoned by skill bugs.
   */
  private markHealthFromExecuteError(
    skill: import('./skill').Skill,
    err: unknown,
    log: (msg: string) => void,
    jobId: string,
  ): boolean {
    if (!this.healthMonitor) {
      return false;
    }
    const tag = `[${jobId.slice(0, 8)}]`;

    if (err instanceof ScriptBillingExhaustedError) {
      const provider = skill.llmOverride?.provider;
      const model = skill.llmOverride?.model;
      if (!provider || !model) {
        // Script signaled billing exhaustion but the operator didn't
        // declare which (provider, model) the script depends on - we
        // can't mark anything unhealthy. Surface a hint in the operator
        // log so they know to add provider/model to SKILL.md.
        log(
          `${tag} Script returned exit ${err.exitCode} (billing-exhausted) but skill "${skill.name}" did not declare provider/model in SKILL.md - cannot gate future jobs.`,
        );
        return false;
      }
      log(
        `${tag} Script signaled billing-exhausted (exit ${err.exitCode}). Marking ${provider}/${model} unhealthy; future jobs against this pair will be refused until recovery probe succeeds.`,
      );
      this.healthMonitor.markUnhealthyFromJob(provider, model, 'billing', err.message);
      return true;
    }

    if (skill.mode === 'llm' && skill.resolvedTriple) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /API error:\s*(\d{3})\b\s*(.*)/i.exec(message);
      if (!match) {
        return false;
      }
      const status = Number(match[1]);
      const body = (match[2] ?? '').slice(0, 200);
      const isBillingStatus = status === 402;
      const isAuthStatus = status === 401 || status === 403;
      const isBilling400 = status === 400 && bodyLooksLikeBilling(body);
      const isBilling429 = status === 429 && bodyLooksLikeBilling(body);
      if (!isBillingStatus && !isAuthStatus && !isBilling400 && !isBilling429) {
        return false;
      }
      const reason: 'billing' | 'invalid' = isAuthStatus ? 'invalid' : 'billing';
      const provider = skill.resolvedTriple.provider;
      const model = skill.resolvedTriple.model;
      log(
        `${tag} LLM provider returned HTTP ${status} (${reason}). Marking ${provider}/${model} unhealthy; future jobs against this pair will be refused until recovery probe succeeds.`,
      );
      this.healthMonitor.markUnhealthyFromJob(provider, model, reason, body);
      return true;
    }

    return false;
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

      // Free-LLM extra protection: only applies when the matched skill
      // is mode='llm' and price=0. Routes through skills.route once;
      // result is reused below in `executeJob`. We `peek` first across
      // all tiers and only `check` when every tier passes, so a denial
      // in tier N never consumes a slot in tiers < N.
      const matched = this.skills.route(job.tags);
      const isFreeLlm = matched?.mode === 'llm' && matched.priceSubunits === 0;
      let perCustomerLimiter: SlidingWindowLimiter | undefined;
      let perSkillKey: string | undefined;
      if (isFreeLlm && matched) {
        if (!this.freeLlmLimiters.globalLimiter.peek(FREE_LLM_GLOBAL_KEY).allowed) {
          this.transport
            .sendFeedback(job, { type: 'error', message: 'Rate limited, try again later' })
            .catch(() => {});
          return;
        }
        perCustomerLimiter = this.freeLlmLimiters.getPerCustomerLimiter(
          matched.name,
          matched.rateLimit,
        );
        perSkillKey = freeLlmCustomerKey(job.customerId, matched.name);
        if (!perCustomerLimiter.peek(perSkillKey).allowed) {
          this.transport
            .sendFeedback(job, { type: 'error', message: 'Rate limited, try again later' })
            .catch(() => {});
          return;
        }
      }

      // All checks passed - record the hit against every active limiter.
      this.customerLimiter.check(job.customerId);
      this.globalLimiter.check(GLOBAL_LIMITER_KEY);
      if (isFreeLlm && perCustomerLimiter && perSkillKey) {
        this.freeLlmLimiters.globalLimiter.check(FREE_LLM_GLOBAL_KEY);
        perCustomerLimiter.check(perSkillKey);
      }

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

    // Wait for shutdown signal. SIGINT and SIGTERM share an idempotent
    // handler so we don't log "Shutting down..." twice when both arrive
    // (shells sometimes deliver SIGINT+SIGTERM to the whole process group).
    await new Promise<void>((resolve) => {
      this.abortController.signal.addEventListener('abort', () => resolve(), { once: true });

      let shuttingDown = false;
      const onSignal = (): void => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        log('Shutting down...');
        this.stop();
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
  }

  /** Drop expired hits from every sliding-window limiter. */
  private cleanupRateLimits(): void {
    this.customerLimiter.prune();
    this.globalLimiter.prune();
    this.freeLlmLimiters.globalLimiter.prune();
    this.freeLlmLimiters.prunePerCustomer();
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

      // Status transitions on failure:
      //   - `executed`: never markFailed - delivery recovery will retry.
      //   - `paid` + `AgentUnavailableError`: keep as `paid` so the recovery
      //     loop re-executes once the LLM pair flips back to healthy. The
      //     customer paid, so abandoning the job to `failed` would lose
      //     their funds with no path back. The recovery loop's gate-aware
      //     check (assertReady) and 24h hard cutoff bound the wait.
      //   - everything else: markFailed as before.
      const currentStatus = this.ledger.getStatus(job.jobId);
      const keepPaidForRecovery = e instanceof AgentUnavailableError && currentStatus === 'paid';
      if (currentStatus !== 'executed' && !keepPaidForRecovery) {
        this.ledger.markFailed(job.jobId);
      }
      if (keepPaidForRecovery) {
        log(
          `[${job.jobId.slice(0, 8)}] Keeping status=paid; recovery will re-execute when LLM pair recovers (24h cutoff).`,
        );
      }
      this.callbacks.onJobError?.(job.jobId, e.message);

      // W8: Sanitize error messages before sending to customer.
      // `AgentUnavailableError` is the runtime's own marker for a
      // billing/invalid health flip and carries the canonical
      // customer-facing string - pass it through verbatim. Anything
      // mentioning "API" otherwise is a leaky provider error and gets
      // masked.
      let safeMessage: string;
      if (e instanceof AgentUnavailableError) {
        safeMessage = e.message;
      } else if (e.message?.includes('API')) {
        safeMessage = 'Internal processing error';
      } else {
        safeMessage = e.message ?? 'Unknown error';
      }
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

    // ── Preflight: gate LLM-dependent jobs against the health monitor
    // before sending payment-required. If the operator's API key has gone
    // invalid/billing-exhausted since startup, refuse the job before the
    // customer pays and before we record anything in the ledger.
    //
    // Two paths feed the gate:
    //   - mode === 'llm' uses `resolvedTriple` (provider + model + maxTokens)
    //     resolved at startup from agent default + skill override.
    //   - script modes use `llmOverride.provider`+`.model` declared in
    //     SKILL.md to signal "this script depends on this API key"; the
    //     runtime registers the same (provider, model) pair with the
    //     health monitor in start.ts, so assertReady works identically.
    //
    // Customer-facing message stays generic to avoid leaking billing
    // status; operator log carries the real reason via the throw.
    const matched = this.skills.route(job.tags);
    const healthPair = resolveHealthPair(matched);
    if (this.healthMonitor && healthPair) {
      try {
        await this.healthMonitor.assertReady(healthPair.provider, healthPair.model);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`[${job.jobId.slice(0, 8)}] LLM health gate refused job: ${detail}`);
        await this.transport
          .sendFeedback(job, {
            type: 'error',
            message: AGENT_UNAVAILABLE_MESSAGE,
          })
          .catch(() => {});
        return;
      }
    }

    // ── Step 1: Resolve per-capability price and collect payment ──
    const jobPrice = resolveJobPrice(job.tags, this.skills);
    const jobAsset = resolveJobAsset(job.tags, this.skills);
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
      const result = await this.collectPayment(job, jobPrice, jobAsset, signal);
      netAmount = result.netAmount;
      paymentRequest = result.paymentRequest;
      // Update ledger with payment info
      this.ledger.updatePayment(job.jobId, netAmount, paymentRequest);
      log(
        `[${job.jobId.slice(0, 8)}] Payment confirmed: ${formatAssetAmount(
          jobAsset,
          BigInt(netAmount),
        )}`,
      );
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
    // Wrapped so a billing/invalid signal surfaced *during* execution
    // (script exit 42 or LLM 402/401) flips the matching health pair to
    // unhealthy. The next job hitting the same pair will be refused at
    // the preflight gate before payment, instead of sailing through and
    // failing again. Recovery happens via the lazy recovery loop, which
    // re-probes only while the pair is unhealthy.
    let output;
    try {
      output = await skill.execute(
        {
          data: job.input,
          inputType: job.inputType,
          tags: job.tags,
          jobId: job.jobId,
        },
        { ...this.skillCtx, signal },
      );
    } catch (err) {
      const flippedToUnhealthy = this.markHealthFromExecuteError(skill, err, log, job.jobId);
      // When the skill failure was the trigger that flipped the health
      // pair to unhealthy, surface a stable "agent unavailable" message
      // to the customer rather than the sanitized "Internal processing
      // error" string the leaky-API masker would otherwise produce.
      // Recovery happens through the lazy recovery loop.
      if (flippedToUnhealthy) {
        throw new AgentUnavailableError();
      }
      throw err;
    }

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
    jobAsset: Asset,
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
      { expirySecs: this.config.paymentTimeoutSecs, asset: jobAsset },
    );
    const requestJson = JSON.stringify(request);

    const fee = calculateProtocolFee(jobPrice, protocolConfig.feeBps);
    const netAmount = jobPrice - fee;

    log(
      `[${job.jobId.slice(0, 8)}] Payment required: ${formatAssetAmount(jobAsset, BigInt(jobPrice))} ` +
        `(fee: ${formatAssetAmount(jobAsset, BigInt(fee))})`,
    );

    // Store payment request reference early for crash recovery
    this.ledger.updatePayment(job.jobId, undefined, requestJson);

    // Send PaymentRequired feedback to customer
    await this.transport.sendFeedback(job, {
      type: 'payment-required',
      amount: jobPrice,
      paymentRequest: requestJson,
      chain: 'solana',
    });

    // Verify payment on-chain. Two paths run in parallel, both self-bounded:
    //   (a) Signature path - subscribe to the customer's payment-completed
    //       Nostr feedback, take the tx signature it carries, and verify it
    //       directly via `getTransaction(sig, 'confirmed')`. Fast (~1-3s) and
    //       cheap on RPC quota. Self-times out after SIG_PATH_TIMEOUT_MS so an
    //       abandoned customer does not hold a `p-limit` slot indefinitely.
    //   (b) Reference path - SDK's getSignaturesForAddress(reference) loop.
    //       Slower and more brittle on the public devnet RPC, but works as a
    //       fallback when Nostr feedback is dropped. Self-times out via SDK
    //       retry budget (~30s).
    // First `verified: true` wins; if both fail we resolve immediately with
    // the last failure. The outer `deadlineMs` backstop only triggers if both
    // paths somehow hang past their own timeouts.
    const rpc = createSolanaRpc(getRpcUrl(this.config.network));
    const verifyAbort = new AbortController();
    const onOuterAbort = () => verifyAbort.abort();
    if (signal) {
      if (signal.aborted) {
        verifyAbort.abort();
      } else {
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }
    const deadlineMs = this.config.paymentTimeoutSecs * 1000;
    const sigPathTimeoutMs = Math.min(deadlineMs, SIG_PATH_TIMEOUT_MS);

    let result: { verified: boolean };
    try {
      result = await new Promise<{ verified: boolean }>((resolve, reject) => {
        let settled = false;
        let pending = 2;
        let lastResult: { verified: boolean } = { verified: false };

        const win = (verified: { verified: boolean }) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve(verified);
        };

        const lose = (verified: { verified: boolean }, reason: string) => {
          if (settled) {
            return;
          }
          lastResult = verified;
          pending -= 1;
          log(`[${job.jobId.slice(0, 8)}] verify ${reason}`);
          if (pending === 0) {
            settled = true;
            clearTimeout(deadline);
            resolve(lastResult);
          }
        };

        // Path (a) - signature path
        this.transport
          .waitForPaymentSignature(job.jobId, job.customerId, verifyAbort.signal, sigPathTimeoutMs)
          .then(async (sig) => {
            if (settled) {
              return;
            }
            if (!sig) {
              lose({ verified: false }, 'sig path: no payment-completed feedback');
              return;
            }
            log(`[${job.jobId.slice(0, 8)}] verify sig path: got ${sig.slice(0, 8)}...`);
            try {
              const verified = await payment.verifyPayment(rpc, request, protocolConfig, {
                txSignature: sig,
              });
              if (verified.verified) {
                win(verified);
              } else {
                const reason = (verified as { error?: string }).error ?? 'unknown';
                lose(verified, `sig path: not verified (${reason})`);
              }
            } catch (err) {
              lose(
                { verified: false },
                `sig path error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })
          .catch((err) =>
            lose(
              { verified: false },
              `sig path error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );

        // Path (b) - reference path
        payment
          .verifyPayment(rpc, request, protocolConfig)
          .then((verified) => {
            if (verified.verified) {
              win(verified);
            } else {
              const reason = (verified as { error?: string }).error ?? 'unknown';
              lose(verified, `ref path: not verified (${reason})`);
            }
          })
          .catch((err) =>
            lose(
              { verified: false },
              `ref path error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );

        // Hard deadline backstop - guarantees we never hang past paymentTimeoutSecs
        const deadline = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          log(`[${job.jobId.slice(0, 8)}] verify deadline (${deadlineMs}ms) hit`);
          resolve(lastResult);
        }, deadlineMs);

        // Outer abort propagation
        if (signal?.aborted) {
          settled = true;
          clearTimeout(deadline);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(deadline);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    } finally {
      verifyAbort.abort();
      if (signal) {
        signal.removeEventListener('abort', onOuterAbort);
      }
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

    // If any pending `paid` job is parked on an unhealthy LLM pair,
    // fire a probe so the recovery loop's gate (assertReady in
    // recoverSingleJob) sees fresh state on the next tick. The lazy
    // health-recovery loop probes every 5 minutes by itself; we add
    // this trigger so paid jobs don't sit idle for that long once the
    // operator fixes their API key. Fire-and-forget: we don't want to
    // block the per-tick recovery iteration on a network probe.
    if (this.healthMonitor) {
      const snap = this.healthMonitor.snapshot();
      const unhealthyKeys = new Set(
        snap
          .filter(
            (entry) =>
              entry.status === 'invalid' ||
              entry.status === 'billing' ||
              entry.status === 'unavailable',
          )
          .map((entry) => `${entry.provider}::${entry.model}`),
      );
      if (unhealthyKeys.size > 0) {
        const hasPaidOnUnhealthy = pending.some((entry) => {
          if (entry.status !== 'paid') {
            return false;
          }
          const skill = this.skills.route(entry.tags);
          const pair = resolveHealthPair(skill);
          return pair !== null && unhealthyKeys.has(`${pair.provider}::${pair.model}`);
        });
        if (hasPaidOnUnhealthy) {
          void this.healthMonitor.refreshUnhealthy().catch(() => {
            /* probe surfaces its own errors via the snapshot */
          });
        }
      }
    }

    for (const entry of pending) {
      const ageMs = (Math.floor(Date.now() / 1000) - entry.created_at) * 1000;
      const expired = ageMs > MAX_PAID_AGE_MS;
      const exhaustedRetries = entry.retry_count >= this.config.recoveryMaxRetries;
      if (expired || exhaustedRetries) {
        this.ledger.markFailed(entry.job_id);
        const reason = expired
          ? 'Job permanently failed: agent did not recover within 24 hours'
          : 'Job permanently failed after maximum retries';
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
                { type: 'error', message: reason },
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
        // Re-deliver only - no LLM call, no gate check.
        this.ledger.incrementRetry(entry.job_id);
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

        // Gate the retry against the LLM health monitor: if the pair is
        // still unhealthy, skip THIS tick without burning a retry. The
        // outer loop will re-schedule us; a successful probe (lazy
        // recovery loop or explicit refreshUnhealthy) flips the pair
        // back to healthy and the next tick proceeds. Without this
        // check, every recovery tick during a billing outage would
        // re-spawn the script, fail with exit 42, and consume one of
        // the bounded retry slots even though the underlying problem
        // (operator's API key) hasn't been touched yet.
        const healthPair = resolveHealthPair(skill);
        if (this.healthMonitor && healthPair) {
          try {
            await this.healthMonitor.assertReady(healthPair.provider, healthPair.model);
          } catch (err) {
            if (err instanceof LlmHealthError) {
              log(
                `[${entry.job_id.slice(0, 8)}] Recovery: pair ${healthPair.provider}/${healthPair.model} still unhealthy (${err.reason}); waiting for recovery probe.`,
              );
              return;
            }
            throw err;
          }
        }

        this.ledger.incrementRetry(entry.job_id);

        // Re-verify payment if reference was stored but confirmation lost to crash
        if (skill.priceSubunits > 0 && !entry.net_amount) {
          if (entry.payment_request) {
            const verified = await this.reVerifyPayment(
              entry,
              skill.priceSubunits,
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
    priceSubunits: number,
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
        const fee = calculateProtocolFee(priceSubunits, protocolConfig.feeBps);
        const netAmount = priceSubunits - fee;
        this.ledger.updatePayment(entry.job_id, netAmount, entry.payment_request);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: payment re-verified (${netAmount} subunits)`);
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
