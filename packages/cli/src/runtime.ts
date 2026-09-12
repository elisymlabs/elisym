import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
/**
 * AgentRuntime - main job processing loop with concurrency, payment, and recovery.
 * Supports per-capability pricing: each capability can have a different price.
 */
import {
  MAX_PROOF_TTL_SECS,
  NATIVE_SOL,
  PROOF_CLOCK_SKEW_SECS,
  SolanaPaymentStrategy,
  buildDelegatedTransfer,
  buildSignedPull,
  calculateProtocolFee,
  confirmPullToTerminal,
  createSlidingWindowLimiter,
  decodeJobPayload,
  deriveOwnerDelegationAta,
  formatAssetAmount,
  getDelegation,
  getProtocolConfig,
  getProtocolProgramId,
  isDefinitelyUnpaid,
  LIMITS,
  parseDelegatedPayment,
  readAcceptedTransports,
  resolveDelegationAsset,
  sendConfirmToTerminal,
  utf8ByteLength,
  verifyDelegationAuthProof,
} from '@elisym/sdk';
import type {
  Asset,
  BlossomBlobTransport,
  DelegatedPaymentRequest,
  ElisymIdentity,
  FileAttachment,
  FileTransport,
  Network,
  ProtocolConfigInput,
  PullTerminalOutcome,
  Signer,
  SlidingWindowLimiter,
  TransportKind,
} from '@elisym/sdk';
import {
  createFreeLlmLimiterSet,
  FREE_LLM_GLOBAL_KEY,
  freeLlmCustomerKey,
  LlmHealthError,
  ScriptBillingExhaustedError,
  ScriptExecutionError,
  type FreeLlmLimiterSet,
  type LlmHealthMonitor,
} from '@elisym/sdk/llm-health';
import type { IrohBlobTransport } from '@elisym/sdk/node';
import type { ChatTurn } from '@elisym/sdk/skills';
import { createSolanaRpc, signature as asSignature } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import pLimit from 'p-limit';
import { getRpcUrl } from './helpers.js';
import { JobLedger, UsedNonceStore } from './ledger.js';
import {
  SESSION_MAX_CONCURRENT_JOBS,
  type RecoverySessionRef,
  type SessionStore,
} from './sessions.js';
import type { Skill, SkillRegistry, SkillContext, SkillOutput } from './skill';
import type { NostrTransport, IncomingJob } from './transport/nostr.js';
import { X402PreflightError, X402TransientError } from './x402/errors.js';

const payment = new SolanaPaymentStrategy();
const LEDGER_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirrors plugin
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
  network: Network;
  solanaAddress?: string;
  maxQueueSize?: number;
  /**
   * Agent-level default execution budget (seconds) applied to skills that do
   * not set their own `max_execution_secs`. `0` or `undefined` => unlimited
   * (the protocol imposes no default; the operator owns this). A per-skill
   * `executionTimeoutSecs` takes precedence over this.
   */
  executionTimeoutSecs?: number;
  /**
   * The agent's dedicated delegate signer for delegated job payment
   * (spl-approve pulls). Deliberately NOT the payment key - the runtime holds
   * only the delegate key, so a runtime compromise is bounded by the on-chain
   * `delegated_amount`, never the revenue wallet. Absent => delegated jobs are
   * rejected at pre-check.
   */
  delegateSigner?: Signer;
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

/**
 * System prompt for the compaction summarize call. Runs on the invoked skill's
 * own resolved LLM.
 */
const SESSION_SUMMARIZE_SYSTEM =
  'Summarize the following conversation between a user and an assistant so the ' +
  'conversation can continue with your summary standing in for the older turns. ' +
  'Preserve facts, decisions, names, numbers, constraints, and open questions. ' +
  'Reply with the summary only.';

/**
 * Stored user-turn content: what the LLM saw as input, plus a file placeholder
 * appended (never replacing - a file-plus-note input keeps the note) when the
 * job carried a file input on the filePath branch.
 */
function buildUserRecord(data: string, fileName: string | undefined): string {
  if (fileName === undefined) {
    return data;
  }
  const placeholder = `[file input: ${fileName}]`;
  return data.length > 0 ? `${data}\n${placeholder}` : placeholder;
}

/**
 * Stored assistant-turn content: what the skill produced (`output.data`, NOT
 * the delivered wire content, which is empty when the payload spills), plus
 * file-result placeholders (unreachable for llm-mode skills today - kept for
 * shape symmetry with the input side).
 */
function buildAssistantRecord(output: SkillOutput): string {
  let filePaths: string[] = [];
  if (output.filePaths !== undefined && output.filePaths.length > 0) {
    filePaths = output.filePaths;
  } else if (output.filePath !== undefined) {
    filePaths = [output.filePath];
  }
  if (filePaths.length === 0) {
    return output.data;
  }
  const placeholders = filePaths.map((path) => `[file result: ${basename(path)}]`).join('\n');
  return output.data.length > 0 ? `${output.data}\n${placeholders}` : placeholders;
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
 * Markers that indicate a script-skill failure (non-zero exit, non-42)
 * actually carried a billing / invalid-key signal in its stderr/stdout.
 * Reserved for the case where the script author did not honor the
 * `SCRIPT_EXIT_BILLING_EXHAUSTED = 42` contract - common with shell
 * proxies that exit 1 on every error path and dump the provider's body
 * verbatim ("Anthropic count_tokens error: invalid x-api-key" etc).
 *
 * Detecting these in the runtime means an operator's misbehaving script
 * still flips the health pair to unhealthy, so the next customer is
 * refused at the preflight gate (before payment) instead of paying for
 * a job that will fail identically.
 *
 * Superset of `BILLING_BODY_MARKERS`: adds auth-language markers
 * (`x-api-key`, `invalid api key`, `unauthorized`, ...) that are
 * specific to the auth/invalid bucket rather than the billing bucket.
 */
const SCRIPT_BILLING_INVALID_MARKERS = [
  'credit balance',
  'billing',
  'insufficient',
  'insufficient_quota',
  'x-api-key',
  'invalid api key',
  'invalid_api_key',
  'authentication_error',
  'unauthorized',
  'unauthenticated',
];

function scriptMessageLooksLikeBillingOrInvalid(message: string): boolean {
  const lower = message.toLowerCase();
  return SCRIPT_BILLING_INVALID_MARKERS.some((marker) => lower.includes(marker));
}

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

/**
 * Thrown by the execute wrapper when a job exceeds its resolved execution
 * budget (`max_execution_secs` on the skill / `execution_timeout_secs` on the
 * agent). Kept distinct from `AgentUnavailableError` so a budget abort is NOT
 * misclassified as a health flip: the job is marked `failed` (not kept `paid`
 * for recovery), and the message - free of the `API` substring - is forwarded
 * verbatim past `processJob`'s leaky-error masker.
 */
class ExecutionBudgetExceededError extends Error {
  constructor(budgetMs: number) {
    super(`Execution exceeded budget (${Math.round(budgetMs / 1000)}s)`);
    this.name = 'ExecutionBudgetExceededError';
  }
}

/**
 * Thrown when seeding the RESULT blob (iroh/blossom) fails or times out AFTER the
 * skill produced output. Kept distinct so the post-execute catch keeps the job
 * `paid` (not `failed`) - the recovery loop then re-delivers it on a freshly-reset
 * iroh node. The message is customer-safe (no internals); the real cause is logged.
 */
class SeedFailedError extends Error {
  constructor(cause?: unknown) {
    super('Result is ready - delivery is retrying and will arrive shortly.', { cause });
    this.name = 'SeedFailedError';
  }
}

/**
 * Thrown when on-chain payment verification times out but the customer was NOT
 * conclusively shown to have abandoned the job (the reference scan did not return
 * the definitive "no matching transaction" result, or the customer asserted a
 * signature we could not yet confirm). Kept distinct so `processJob` keeps the job
 * `paid` instead of marking it `failed`: a payment that confirms shortly after the
 * timeout (e.g. a lagging devnet RPC) is then picked up by recovery's reVerifyPayment
 * rather than being silently lost. A conclusively-abandoned job throws a plain Error
 * and is still marked failed.
 */
class PaymentTimeoutError extends Error {
  constructor() {
    super('Payment verification timed out; awaiting late confirmation.');
    this.name = 'PaymentTimeoutError';
  }
}

// A dynamic-script result is written to a temp file literally named `output` (no
// extension), so the customer would download a bare `output` with no extension.
// Derive a sensible extension from the declared output MIME; unknown MIME → none.
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/zip': '.zip',
};

function extensionForMime(mime: string | undefined): string {
  return mime ? (MIME_EXTENSIONS[mime] ?? '') : '';
}

// Seeding is local (hash + store-copy + ticket mint); anything slower than this is
// worth an operator log line to pin a misbehaving native addon before it times out.
const SLOW_SEED_LOG_MS = 5_000;

// Allowlist of safe, informative messages the runtime itself produces and may
// forward verbatim to a remote customer. Everything not matched here (raw script
// stderr, provider internals, unexpected errors) collapses to a fixed generic
// string; full detail is kept in the operator log only.
const CUSTOMER_SAFE_MESSAGE_PREFIXES = ['Input too long', 'No skill matched', 'Payment timeout'];

/**
 * Resolve the error message that is safe to send to a remote customer. Inverts
 * the old leaky denylist (forward-unless-contains-"API") into an allowlist so
 * raw subprocess output or provider error bodies can never leak.
 */
function customerSafeMessage(error: unknown): string {
  if (
    error instanceof AgentUnavailableError ||
    error instanceof ExecutionBudgetExceededError ||
    error instanceof SeedFailedError
  ) {
    return error.message;
  }
  if (error instanceof ScriptExecutionError) {
    // Generic summary only - `error.detail` (raw stderr/stdout) stays operator-side.
    return error.message;
  }
  if (error instanceof ScriptBillingExhaustedError) {
    return AGENT_UNAVAILABLE_MESSAGE;
  }
  if (
    error instanceof Error &&
    CUSTOMER_SAFE_MESSAGE_PREFIXES.some((prefix) => error.message.startsWith(prefix))
  ) {
    return error.message;
  }
  return 'Internal processing error';
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

/**
 * Customer-facing rejection prefix for the delegated pre-check. Reasons appended
 * to it are fixed, internal-free strings (safe to send verbatim via feedback).
 */
const DELEGATED_REJECTED_PREFIX = 'Delegated payment rejected';

/**
 * Reconcile re-poll depth for a persisted pull signature. Deliberately deeper
 * than the live path's default: a false "absent" during reconcile means a
 * customer was charged with no result, so absence must be proven harder.
 */
const RECONCILE_RECHECK_ATTEMPTS = 6;

/** Everything the delegated pull needs, resolved ONCE at pre-check. */
interface DelegatedPullContext {
  request: DelegatedPaymentRequest;
  delegateSigner: Signer;
  /** The owner's delegated USDC ATA (source of funds). */
  ownerAta: string;
  /**
   * The skill price. This is the amount RESERVED (cap check, balance check,
   * `delegationInFlight`) and, for a non-metered skill, also the exact pull
   * amount. For a metered skill it is the CEILING - see `chargedSubunits`.
   *
   * Reserve and release must both use THIS field, never the charged one:
   * `releaseDelegationReservation` saturates at zero and drops the key, so
   * releasing less than was reserved leaks in-flight subunits for the process
   * lifetime, and releasing more zeroes a concurrent job's reservation for the
   * same owner.
   */
  priceSubunits: bigint;
  /**
   * What the pull actually moves, set after execution for a metered skill and
   * clamped into `[meteredMinSubunits, priceSubunits]`. Undefined means "charge
   * the ceiling" - a non-metered skill, or a metered one that reported nothing.
   */
  chargedSubunits?: bigint;
  rpc: Rpc<SolanaRpcApi>;
  network: Network;
  /** Set after phase A (sign + persist); rides the result event as a `tx` tag. */
  pullSignature?: string;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// Free-skill caps: tight, because there is no economic deterrent against
// loop/Sybil spam. With window == paymentTimeoutSecs (both 10 min by
// default) these double as per-customer queue-depth caps for unpaid claims.
const FREE_MAX_JOBS_PER_CUSTOMER = 20;
const FREE_GLOBAL_MAX_JOBS_PER_WINDOW = 200;
// Paid-skill caps: 10x looser. Payment is the economic deterrent against
// loop abuse, but the sliding-window cap is still needed to bound the
// "claim paid skill but never pay" queue-spam vector. 200 per customer
// supports legitimate batch workloads (e.g. translating a 200-paragraph
// document) without rejecting; 2000 global leaves room for ~10 concurrent
// batch customers before saturation kicks in.
const PAID_MAX_JOBS_PER_CUSTOMER = 200;
const PAID_GLOBAL_MAX_JOBS_PER_WINDOW = 2000;
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
  /** Per-customer sliding-window rate limiter for free skills. */
  private freeCustomerLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: FREE_MAX_JOBS_PER_CUSTOMER,
    maxKeys: MAX_TRACKED_CUSTOMERS,
  });
  /** Global sliding-window rate limiter for free skills (Sybil protection). */
  private freeGlobalLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: FREE_GLOBAL_MAX_JOBS_PER_WINDOW,
    maxKeys: 1,
  });
  /**
   * Per-customer sliding-window limiter for paid skills (10x looser than free).
   * Payment is the primary economic deterrent; this cap exists to bound the
   * "claim paid skill but never pay" queue-spam vector.
   */
  private paidCustomerLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: PAID_MAX_JOBS_PER_CUSTOMER,
    maxKeys: MAX_TRACKED_CUSTOMERS,
  });
  /** Global sliding-window limiter for paid skills (Sybil protection, 10x free). */
  private paidGlobalLimiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerWindow: PAID_GLOBAL_MAX_JOBS_PER_WINDOW,
    maxKeys: 1,
  });
  /**
   * Two-tier limiter applied only to free LLM skills (mode='llm', price=0).
   * Existing per-customer + global limiters above remain in effect for all
   * jobs; this set adds tighter caps to prevent unpaid spam from draining
   * the operator's API key.
   */
  private freeLlmLimiters: FreeLlmLimiterSet = createFreeLlmLimiterSet();

  /**
   * Per-owner in-flight delegated reservations (subunits). A concurrency gate,
   * NOT a budget: released on success AND failure (unlike the MCP session-spend
   * reservation, which sticks on success). Process-local by design - the
   * on-chain `delegated_amount` is the real ceiling.
   */
  private delegationInFlight = new Map<string, bigint>();

  constructor(
    private transport: NostrTransport,
    private skills: SkillRegistry,
    private skillCtx: SkillContext,
    private config: RuntimeConfig,
    private ledger: JobLedger,
    private callbacks: RuntimeCallbacks = {},
    private healthMonitor?: LlmHealthMonitor,
    private irohTransport?: IrohBlobTransport,
    private identity?: ElisymIdentity,
    private blossomTransport?: BlossomBlobTransport,
    private sessionStore?: SessionStore,
    private nonceStore?: UsedNonceStore,
  ) {
    this.limit = pLimit(config.maxConcurrentJobs);
    this.maxQueueSize = config.maxQueueSize ?? config.maxConcurrentJobs * 10;
  }

  /**
   * Whether a job takes the session path: session ref present (transport only
   * populates it for NIP-44-encrypted requests) AND the matched skill opted in
   * (`context: true` - llm or dynamic-script mode) AND a session store is
   * wired. Everything else processes stateless - deterministically, never
   * implicitly per-pubkey.
   */
  private resolveJobSession(
    job: Pick<IncomingJob, 'session' | 'customerId'>,
    skill: Skill | null | undefined,
  ): { store: SessionStore; customerId: string; sessionId: string; skill: Skill } | null {
    if (
      job.session === undefined ||
      this.sessionStore === undefined ||
      skill === null ||
      skill === undefined ||
      (skill.mode !== 'llm' && skill.mode !== 'dynamic-script') ||
      skill.context !== true
    ) {
      return null;
    }
    return {
      store: this.sessionStore,
      customerId: job.customerId,
      sessionId: job.session.id,
      skill,
    };
  }

  /**
   * Run a session-path execution: history load -> execute -> append, under the
   * session mutex. Lock-order invariant: callers already hold their `pLimit`
   * slot (live and recovery paths alike), so a mutex holder never waits for a
   * slot. The mutex is released after the append, BEFORE result seeding and
   * delivery - it never spans that network I/O (the execute callback's own LLM
   * call, and the compaction summarize below, are bounded by the LLM HTTP
   * timeout). Appends only happen on execution success; a failed job leaves
   * the transcript untouched.
   */
  private async runSessionExchange(params: {
    session: { store: SessionStore; customerId: string; sessionId: string; skill: Skill };
    jobId: string;
    userRecord: string;
    signal: AbortSignal | undefined;
    log: (message: string) => void;
    /** Existing execute closure (budget race, health marking) - unchanged. */
    execute: (history?: ChatTurn[]) => Promise<SkillOutput>;
    /** Crash recovery: exclude this job's own recorded turns from the history. */
    excludeOwnTurns?: boolean;
  }): Promise<SkillOutput> {
    const { store, customerId, sessionId, skill } = params.session;
    const release = await store.acquire(customerId, sessionId);
    try {
      const opened = store.open(
        customerId,
        sessionId,
        params.excludeOwnTurns === true ? params.jobId : undefined,
      );
      let messages = opened.messages;

      if (!opened.stateless && opened.compactionNeeded && opened.summarizeText !== undefined) {
        messages = await this.compactSession({
          store,
          customerId,
          sessionId,
          skill,
          summarizeText: opened.summarizeText,
          fallbackMessages: messages,
          signal: params.signal,
          log: params.log,
          jobId: params.jobId,
        });
      }

      const history = opened.stateless || messages.length === 0 ? undefined : messages;
      const output = await params.execute(history);

      if (!opened.stateless) {
        store.appendExchange(customerId, sessionId, {
          jobId: params.jobId,
          capability: skill.name,
          userContent: params.userRecord,
          assistantContent: buildAssistantRecord(output),
          skipRoles: opened.recordedRoles,
        });
      }
      return output;
    } finally {
      release();
    }
  }

  /**
   * Compaction: one summarize call on the invoked skill's own resolved LLM,
   * then an atomic rewrite to `[summary, ...kept tail]`. Any failure - thrown
   * error, missing client, or an empty-string summary (rewriting on it would
   * silently vaporize the summarized context, since empty messages are skipped
   * at replay) - counts a strike and processes this job with the uncompacted
   * history; after 2 consecutive strikes the store force-truncates without a
   * summary so a small-window model can never permanently brick a session.
   */
  private async compactSession(params: {
    store: SessionStore;
    customerId: string;
    sessionId: string;
    skill: Skill;
    summarizeText: string;
    fallbackMessages: ChatTurn[];
    signal: AbortSignal | undefined;
    log: (message: string) => void;
    jobId: string;
  }): Promise<ChatTurn[]> {
    const { store, customerId, sessionId, skill } = params;
    try {
      const llm = this.skillCtx.getLlm?.(skill.llmOverride) ?? this.skillCtx.llm;
      if (llm === undefined) {
        throw new Error('no LLM client available for session compaction');
      }
      const summary = await llm.complete(
        SESSION_SUMMARIZE_SYSTEM,
        params.summarizeText,
        params.signal,
      );
      return store.compact(customerId, sessionId, summary);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      params.log(`[${params.jobId.slice(0, 8)}] Session compaction failed: ${detail}`);
      const outcome = store.compactionFailed(customerId, sessionId);
      return outcome.forced && outcome.messages !== undefined
        ? outcome.messages
        : params.fallbackMessages;
    }
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
  /**
   * Build a "and N other model(s) for the same provider" suffix for
   * cascade-narrating log lines. The SDK monitor cascades `invalid` /
   * `billing` flips across every sibling pair sharing the same provider
   * (shared API key); this helper just narrates that to the operator log
   * so they can see why unrelated skills are now refusing jobs.
   */
  private cascadeSuffix(provider: string, triggeringModel: string): string {
    if (!this.healthMonitor) {
      return '';
    }
    let siblings = 0;
    for (const entry of this.healthMonitor.snapshot()) {
      if (entry.provider !== provider) {
        continue;
      }
      if (entry.model === triggeringModel) {
        continue;
      }
      siblings += 1;
    }
    if (siblings === 0) {
      return '';
    }
    return ` (cascading to ${siblings} other model(s) for ${provider} sharing the same API key)`;
  }

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
        `${tag} Script signaled billing-exhausted (exit ${err.exitCode}). Marking ${provider}/${model} unhealthy${this.cascadeSuffix(provider, model)}; future jobs against this pair will be refused until recovery probe succeeds.`,
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
        `${tag} LLM provider returned HTTP ${status} (${reason}). Marking ${provider}/${model} unhealthy${this.cascadeSuffix(provider, model)}; future jobs against this pair will be refused until recovery probe succeeds.`,
      );
      this.healthMonitor.markUnhealthyFromJob(provider, model, reason, body);
      return true;
    }

    // Script-mode failure handling. Policy: fail-fast circuit breaker -
    // ANY non-zero exit on a script-mode skill with a declared
    // (provider, model) flips that pair unhealthy immediately. The next
    // customer is refused at the preflight gate before payment, so a
    // single failed buyer protects everyone behind them until the lazy
    // recovery probe (verifyKeyDeep) confirms the pair is back up.
    //
    // Two flavors, distinguished by whether the failure is shared-key or
    // skill-local:
    //
    //   1. Stderr matches billing/invalid markers ("credit balance",
    //      "x-api-key", "unauthorized", ...) - the upstream API key is
    //      the root cause, so every model under the same provider is
    //      affected. Cascade across siblings.
    //
    //   2. Generic non-zero exit with no recognizable marker - most
    //      likely a per-skill bug (missing env var, malformed response,
    //      broken script). Other models for the same provider are
    //      probably fine. Mark only this pair (`cascade: false`) so a
    //      bug in Sonnet's proxy.sh does not take down Haiku as
    //      collateral damage.
    //
    // Reason is `invalid` for generic exits because it requires operator
    // action to resolve and cached-failure semantics in `probeIfNeeded`
    // keep the gate closed until the lazy recovery loop's verifyKeyDeep
    // probe succeeds. Recovery is API-key-scoped, not script-scoped: if
    // the script bug persists, the next buyer triggers another flip,
    // making the gate self-healing for transient skill bugs but
    // self-flapping for chronic ones (acceptable - operator log makes
    // this visible).
    if (skill.mode !== 'llm') {
      // Use the raw stderr/stdout (`detail`) for billing/invalid marker scanning
      // and the operator log - the generic `.message` no longer carries it.
      let message: string;
      if (err instanceof ScriptExecutionError) {
        message = err.detail;
      } else if (err instanceof Error) {
        message = err.message;
      } else {
        message = String(err);
      }
      const provider = skill.llmOverride?.provider;
      const model = skill.llmOverride?.model;
      if (!provider || !model) {
        log(
          `${tag} Script "${skill.name}" failed ("${message.slice(0, 120)}") but did not declare provider/model in SKILL.md - cannot gate future jobs.`,
        );
        return false;
      }
      const lower = message.toLowerCase();
      const looksBillingOrInvalid = scriptMessageLooksLikeBillingOrInvalid(message);
      const reason: 'billing' | 'invalid' =
        looksBillingOrInvalid &&
        (lower.includes('credit balance') ||
          lower.includes('billing') ||
          lower.includes('insufficient'))
          ? 'billing'
          : 'invalid';
      const cascade = looksBillingOrInvalid;
      const cascadeNote = cascade ? this.cascadeSuffix(provider, model) : ' (no cascade)';
      const signalNote = looksBillingOrInvalid
        ? `${reason} signal in stderr`
        : `generic exit (no billing/invalid markers, classified as ${reason}, skill-local)`;
      log(
        `${tag} Script failure (${signalNote}). Marking ${provider}/${model} unhealthy${cascadeNote}; future jobs against this pair will be refused until recovery probe succeeds.`,
      );
      this.healthMonitor.markUnhealthyFromJob(provider, model, reason, message.slice(0, 200), {
        cascade,
      });
      return true;
    }

    return false;
  }

  /** Fetch on-chain protocol config (fee, treasury). Always fetches fresh to avoid stale treasury. */
  private async fetchProtocolConfig(): Promise<ProtocolConfigInput> {
    const programId = getProtocolProgramId(this.config.network);
    const rpc = createSolanaRpc(getRpcUrl(this.config.network));
    const config = await getProtocolConfig(rpc, programId, this.config.network, {
      forceRefresh: true,
    });
    return { feeBps: config.feeBps, treasury: config.treasury };
  }

  async run(): Promise<void> {
    const log = this.callbacks.onLog ?? console.log;

    // Prune terminal ledger entries past the 30-day retention window.
    this.ledger.pruneOldEntries(LEDGER_RETENTION_MS);

    // Session store: byte-counter scan + TTL GC, sequenced BEFORE recovery
    // (mirrors the ledger prune-before-recovery ordering above).
    this.sessionStore?.init();

    // Reconcile the durable used-nonce set from persisted raw events BEFORE
    // `transport.start` below, so a replay presenting an already-burned nonce
    // is rejected at pre-check even when the nonce-set flush was lost.
    this.reconcileUsedNonces();

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
      try {
        this.sessionStore?.gc();
      } catch (e: any) {
        log(`Session GC error: ${e.message}`);
      }
      try {
        this.nonceStore?.prune();
      } catch (e: any) {
        log(`Nonce GC error: ${e.message}`);
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

      // Route the skill once; reused below for executeJob and to decide
      // which rate-limit tier applies. Free skills (price=0) use the
      // tight default tier; paid skills use the 10x-looser tier because
      // payment is the primary economic deterrent against loop abuse.
      // A missing skill match defaults to the free tier (safe fallback:
      // an attacker cannot bypass tight limits by crafting unmatched tags).
      const matched = this.skills.route(job.tags);
      const isPaid = matched ? matched.priceSubunits > 0 : false;
      const customerLimiter = isPaid ? this.paidCustomerLimiter : this.freeCustomerLimiter;
      const globalLimiter = isPaid ? this.paidGlobalLimiter : this.freeGlobalLimiter;

      // Session admission cap - part of the PEEK phase (no rate-limiter hit is
      // recorded yet, so a session-busy rejection never burns rate budget).
      // Scoped to session-path jobs only: stateless jobs never touch the
      // session mutex, so capping them would be pure downside. The cap bounds
      // slot-time abuse: same-session jobs that reach execution serialize on
      // the session mutex while each holds a p-limit slot.
      const jobSession = this.resolveJobSession(job, matched);
      if (
        jobSession &&
        jobSession.store.admittedCount(jobSession.customerId, jobSession.sessionId) >=
          SESSION_MAX_CONCURRENT_JOBS
      ) {
        this.transport
          .sendFeedback(job, {
            type: 'error',
            message: 'Session busy - wait for the previous message to finish, then retry.',
          })
          .catch(() => {});
        return;
      }

      // Per-customer check first so a rate-limited customer does not
      // bump the global counter - otherwise a single abusive customer
      // could starve every other caller up to the global cap.
      if (!customerLimiter.peek(job.customerId).allowed) {
        this.transport
          .sendFeedback(job, { type: 'error', message: 'Rate limited, try again later' })
          .catch(() => {});
        return;
      }

      // Global rate limiting (Sybil protection).
      if (!globalLimiter.peek(GLOBAL_LIMITER_KEY).allowed) {
        this.transport
          .sendFeedback(job, { type: 'error', message: 'Server busy, try again later' })
          .catch(() => {});
        return;
      }

      // Free-LLM extra protection: applies to any FREE skill that reaches an LLM -
      // every mode='llm' skill, plus script-mode skills that declare a provider+model
      // via llmOverride (resolveHealthPair returns the pair for those). Gating only on
      // mode==='llm' let a free script skill calling an LLM drain the operator's key
      // uncapped. We `peek` first across all tiers and only `check` when every tier
      // passes, so a denial in tier N never consumes a slot in tiers < N.
      const isFreeLlm =
        matched?.priceSubunits === 0 &&
        (matched.mode === 'llm' || resolveHealthPair(matched) !== null);
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
      customerLimiter.check(job.customerId);
      globalLimiter.check(GLOBAL_LIMITER_KEY);
      if (isFreeLlm && perCustomerLimiter && perSkillKey) {
        this.freeLlmLimiters.globalLimiter.check(FREE_LLM_GLOBAL_KEY);
        perCustomerLimiter.check(perSkillKey);
      }

      this.callbacks.onJobReceived?.(job);
      this.inFlight.add(job.jobId);
      this.pending++;
      // Live admitted-counter registration: released in the same finally that
      // tears down inFlight/pending - on EVERY exit path (payment timeout,
      // refusals, failures, success) - or two abandoned unpaid jobs would pin
      // the session "busy" and eviction-immune forever.
      if (jobSession) {
        jobSession.store.admitLive(jobSession.customerId, jobSession.sessionId);
      }

      this.limit(() => this.processJob(job))
        .catch((e: any) => {
          this.callbacks.onJobError?.(job.jobId, e.message);
        })
        .finally(() => {
          this.inFlight.delete(job.jobId);
          this.pending--;
          if (jobSession) {
            jobSession.store.releaseLive(jobSession.customerId, jobSession.sessionId);
          }
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
        // `stop()` is synchronous (aborts in-flight jobs); the iroh node shutdown
        // is async and must release the fs-store lock before exit, so await it
        // here and exit once done. The unref'd 3s timer is the hard-kill fallback.
        const shutdownNode = this.irohTransport?.shutdown() ?? Promise.resolve();
        void shutdownNode.then(
          () => process.exit(0),
          () => process.exit(0),
        );
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
  }

  /** Drop expired hits from every sliding-window limiter. */
  private cleanupRateLimits(): void {
    this.freeCustomerLimiter.prune();
    this.freeGlobalLimiter.prune();
    this.paidCustomerLimiter.prune();
    this.paidGlobalLimiter.prune();
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

  /**
   * Resolve a job's execution budget in milliseconds. Per-skill
   * `executionTimeoutSecs` wins over the agent-level `config.executionTimeoutSecs`;
   * `0` (explicit unlimited) and `undefined` both collapse to `0` => no timer.
   */
  private resolveExecutionBudgetMs(skill: import('./skill').Skill): number {
    const secs = skill.executionTimeoutSecs ?? this.config.executionTimeoutSecs ?? 0;
    return secs > 0 ? secs * 1000 : 0;
  }

  /**
   * Wrapper with error handling. The execution budget (if any) is enforced
   * around `skill.execute` inside `executeJob`, not here - payment collection
   * and result delivery run on their own bounds. `jobAbort` is retained so
   * `stop()` can still abort an in-flight job.
   */
  private async processJob(job: IncomingJob): Promise<void> {
    const jobAbort = new AbortController();
    this.jobAbortControllers.add(jobAbort);
    try {
      await this.executeJob(job, jobAbort.signal);
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
      //   - `paid` + `SeedFailedError`: same - the skill produced output but the
      //     result blob seed failed/timed out; keep `paid` so recovery re-delivers
      //     on a freshly-reset iroh node rather than losing the paid job.
      //   - `paid` + `PaymentTimeoutError`: payment verification timed out but the
      //     customer was not conclusively shown to have abandoned; keep `paid` so
      //     recovery re-verifies a late on-chain payment instead of losing it.
      //   - `paid` + `X402TransientError`: the x402 upstream hiccuped (network,
      //     timeout, 5xx, 429) AFTER the customer paid; keep `paid` so recovery
      //     retries. The driver's idempotency cache + paid-attempt budget bound
      //     the money, so retries are safe.
      //   - `paid` + budget abort on an x402 skill: the bought result may already
      //     sit in the idempotency cache; cache-first recovery delivers it
      //     without paying the upstream again. Recovery's retry cap + 24h cutoff
      //     bound the loop.
      //   - everything else: markFailed as before.
      const currentStatus = this.ledger.getStatus(job.jobId);
      const keepPaidForRecovery =
        (e instanceof AgentUnavailableError ||
          e instanceof SeedFailedError ||
          e instanceof PaymentTimeoutError ||
          e instanceof X402TransientError ||
          (e instanceof ExecutionBudgetExceededError &&
            this.skills.route(job.tags)?.mode === 'x402')) &&
        currentStatus === 'paid';
      if (currentStatus !== 'executed' && !keepPaidForRecovery) {
        this.ledger.markFailed(job.jobId);
      }
      if (keepPaidForRecovery) {
        log(`[${job.jobId.slice(0, 8)}] Keeping status=paid; recovery will retry (24h cutoff).`);
      }
      // Operator log keeps the full detail (including raw script stderr from a
      // ScriptExecutionError); the customer only ever receives an allowlisted,
      // generic message via `customerSafeMessage`.
      const operatorMessage =
        e instanceof ScriptExecutionError
          ? `${e.message}: ${e.detail}`
          : (e.message ?? 'Unknown error');
      this.callbacks.onJobError?.(job.jobId, operatorMessage);

      // W8: only forward known-safe messages to the customer; everything else is
      // masked to a fixed generic string so subprocess/provider internals never leak.
      const safeMessage = customerSafeMessage(e);
      await this.transport
        .sendFeedback(job, { type: 'error', message: safeMessage })
        .catch(() => {});
    } finally {
      this.jobAbortControllers.delete(jobAbort);
    }
  }

  /** Core job processing logic - payment, skill execution, result delivery. */
  private async executeJob(job: IncomingJob, signal?: AbortSignal): Promise<void> {
    const log = this.callbacks.onLog ?? console.log;

    // W2: Validate input length before processing. Byte-based, as defense in depth
    // (the SDK already caps at submit). A spilled job's inline text is '' (the real
    // text rides the attachment), so this only ever fires on a malformed/forged event.
    const inputBytes = utf8ByteLength(job.input);
    if (inputBytes > LIMITS.MAX_INPUT_LENGTH) {
      throw new Error(`Input too long: ${inputBytes} bytes (max ${LIMITS.MAX_INPUT_LENGTH})`);
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

    // ── x402 pre-payment rules ──
    // (a) Attachment rule: spilled >60KB text and real files both arrive as
    // attachments with an EMPTY inline input, invisible to the preflight
    // below. POST bridges accept a text/* attachment up to the skill's input
    // cap (the runtime transparently re-inlines it after payment); anything
    // else - and any attachment on a GET bridge - is refused BEFORE payment.
    // Declared mime/size are envelope fields, readable without fetching the
    // bytes; a lying descriptor is caught again in the executor (filePath
    // guard + actual-size re-check) before any upstream payment.
    if (matched?.mode === 'x402' && job.attachment !== undefined) {
      const method = matched.x402?.method ?? 'POST';
      const maxInputBytes = matched.x402?.maxInputBytes ?? 0;
      const attachmentOk =
        method === 'POST' &&
        job.attachment.mime.startsWith('text/') &&
        job.attachment.size <= maxInputBytes;
      if (!attachmentOk) {
        log(
          `[${job.jobId.slice(0, 8)}] Rejecting attachment on x402 skill (mime=${job.attachment.mime}, size=${job.attachment.size})`,
        );
        await this.transport
          .sendFeedback(job, {
            type: 'error',
            message:
              'This skill accepts inline text input only (or a text attachment within its size limit).',
          })
          .catch(() => {});
        return;
      }
    }

    // (b) Generic pre-payment preflight (x402: wallet invariant, live quote
    // vs ceiling, float balance, live margin, input-size rules). Refuses the
    // job BEFORE recordPaid/payment collection; `input` here is the
    // pre-payment view - inline text only, file inputs are fetched after
    // payment. Customer-facing text stays generic unless the error marks a
    // customer-actionable reason (e.g. input too large).
    if (matched?.preflight) {
      try {
        await matched.preflight(
          { data: job.input, inputType: job.inputType, tags: job.tags, jobId: job.jobId },
          this.skillCtx,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`[${job.jobId.slice(0, 8)}] Preflight refused job: ${detail}`);
        const customerMessage =
          err instanceof X402PreflightError && err.customerMessage !== undefined
            ? err.customerMessage
            : AGENT_UNAVAILABLE_MESSAGE;
        await this.transport
          .sendFeedback(job, { type: 'error', message: customerMessage })
          .catch(() => {});
        return;
      }
    }

    // File inputs require a PAID skill in Phase 1: a free skill would let an
    // attacker make the provider fetch arbitrary blobs with no payment gate.
    // Rejected here, before `recordPaid`, so the job never enters the ledger
    // and the recovery path cannot re-fetch it.
    if (job.attachment !== undefined && resolveJobPrice(job.tags, this.skills) === 0) {
      log(`[${job.jobId.slice(0, 8)}] Rejecting file input on a free skill`);
      await this.transport
        .sendFeedback(job, { type: 'error', message: 'File inputs require a paid skill.' })
        .catch(() => {});
      return;
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

    // Delegated mode routes AWAY from collectPayment entirely: the money move
    // is the provider's post-work pull, gated by the pre-check below.
    const claimsDelegated = job.delegated !== undefined || job.delegatedRejected !== undefined;
    let delegatedPull: DelegatedPullContext | undefined;
    if (claimsDelegated) {
      delegatedPull = await this.delegatedPreCheck(job, matched, log);
      if (delegatedPull === undefined) {
        return; // rejected: entry markFailed + error feedback already sent
      }
      // The pull moves the full price (protocol fee was charged at approve).
      // For a metered skill this is only the CEILING: the real figure is not
      // knowable until the work is done, so `netAmount` is re-read from the
      // pull context after `executeDelegatedPull` and before `deliverResult`.
      netAmount = Number(delegatedPull.priceSubunits);
    } else if (jobPrice > 0) {
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

    // The per-owner reservation must release on EVERY path out of work+pull -
    // success, pull failure, and a skill throw unwinding to processJob's catch.
    try {
      // Fetch a file input (if any) AFTER payment is confirmed - never before, so an
      // unpaid request can't make the provider download attacker-hosted data.
      const inputFile = await this.resolveInputFile(job.attachment, job.customerId, signal);

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
      // Execution budget (if any) is scoped to `skill.execute` only - payment
      // collection above and delivery below run on their own bounds. The budget
      // timer aborts a dedicated `execAbort` chained to the incoming `signal`
      // (so `stop()` still propagates), and sets `budgetExceeded` so the catch
      // can tell a budget abort apart from a real skill failure - the latter
      // would otherwise flip the health pair via `markHealthFromExecuteError`.
      const budgetMs = this.resolveExecutionBudgetMs(skill);
      // Resolved BEFORE the execute closure so the closure can stamp the session
      // id into SkillInput (dynamic scripts receive it as ELISYM_SESSION_ID).
      const jobSession = this.resolveJobSession(job, skill);
      const runExecution = async (history?: ChatTurn[]): Promise<SkillOutput> => {
        let budgetExceeded = false;
        const execAbort = new AbortController();
        const onOuterAbort = (): void => execAbort.abort();
        if (signal) {
          if (signal.aborted) {
            execAbort.abort();
          } else {
            signal.addEventListener('abort', onOuterAbort);
          }
        }
        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const execPromise = skill.execute(
            {
              data: inputFile?.inlineText ?? job.input,
              inputType: job.inputType,
              tags: job.tags,
              jobId: job.jobId,
              filePath: inputFile?.filePath,
              history,
              ...(jobSession !== null ? { sessionId: jobSession.sessionId } : {}),
            },
            { ...this.skillCtx, signal: execAbort.signal },
          );
          // If the budget race rejects first, the skill may settle later; a no-op
          // handler keeps that late settlement from surfacing as an unhandled
          // rejection.
          execPromise.catch(() => {});
          if (budgetMs > 0) {
            // Race the skill against its budget so a skill that ignores the abort
            // signal (or is stuck on a non-abortable await) cannot run past the
            // budget and hold the job slot. `abort()` still asks it to stop
            // (SIGKILL for scripts, next-round check for LLM skills); the race only
            // bounds how long we wait.
            return await Promise.race([
              execPromise,
              new Promise<never>((_resolve, reject) => {
                budgetTimer = setTimeout(() => {
                  budgetExceeded = true;
                  execAbort.abort();
                  reject(new ExecutionBudgetExceededError(budgetMs));
                }, budgetMs);
              }),
            ]);
          }
          return await execPromise;
        } catch (err) {
          // A budget abort is a clean operator/author limit, not a provider fault:
          // mark it distinctly so it never trips the health monitor.
          if (budgetExceeded) {
            log(`[${job.jobId.slice(0, 8)}] Execution exceeded budget (${budgetMs / 1000}s)`);
            throw new ExecutionBudgetExceededError(budgetMs);
          }
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
        } finally {
          if (budgetTimer) {
            clearTimeout(budgetTimer);
          }
          if (signal) {
            signal.removeEventListener('abort', onOuterAbort);
          }
          // Remove the fetched input file (and its temp dir) once execution is done.
          if (inputFile) {
            await inputFile.cleanup().catch(() => {});
          }
        }
      };

      // Session path: history load -> execute -> append run under the session
      // mutex; stateless jobs call the closure directly.
      const output =
        jobSession === null
          ? await runExecution()
          : await this.runSessionExchange({
              session: jobSession,
              jobId: job.jobId,
              userRecord: buildUserRecord(
                inputFile?.inlineText ?? job.input,
                inputFile?.filePath !== undefined
                  ? (job.attachment?.name ?? 'attachment')
                  : undefined,
              ),
              signal,
              log,
              execute: runExecution,
            });

      // ── Step 5: Seed any spilled payload (file or large text), THEN cache ──
      // buildResultAttachment runs before markExecuted: a seed failure leaves the
      // job `paid` so recovery re-executes. `deliveredContent` is empty whenever the
      // payload was spilled to iroh, so the result event carries only the ticket.
      const { attachments, deliveredContent } = await this.buildResultAttachment(
        job.jobId,
        output,
        job.customerId,
        readAcceptedTransports(job.rawEvent.tags),
      );

      // ── Step 5b (delegated): persist result state, then the two-phase pull ──
      // ALL result state (`delivered_content` here; `result_attachments` inside
      // buildResultAttachment above) is flushed STRICTLY before the phase-A
      // pull-signature flush, so a persisted `pull_signature` always implies the
      // result is recoverable and reconcile never delivers an empty result.
      // Status stays `paid` throughout - `executed` would re-route recovery to
      // the re-delivery path for a result whose pull never landed.
      if (delegatedPull !== undefined) {
        // Deliverability gate BEFORE any money moves: the SDK rejects an empty
        // result at delivery (`submitJobResult` throws), so pulling for one
        // would charge the customer for a result that can never be delivered -
        // and the pull-signature recovery exemption would then retry the
        // undeliverable entry forever. Script modes throw on empty output at
        // the source, but llm/x402 modes can legitimately return '' (e.g. a
        // completion with no text block), so the money boundary must re-check.
        if (deliveredContent === '' && attachments.length === 0) {
          this.ledger.markFailed(job.jobId);
          await this.transport
            .sendFeedback(job, {
              type: 'error',
              message: `${DELEGATED_REJECTED_PREFIX}: the skill produced empty output - you were not charged. Please re-submit.`,
            })
            .catch(() => {});
          return;
        }
        this.ledger.recordDeliveredContent(job.jobId, deliveredContent);
        delegatedPull.chargedSubunits = this.resolveMeteredCharge(
          job,
          matched,
          delegatedPull.priceSubunits,
          output.chargeSubunits,
          log,
        );
        const outcome = await this.executeDelegatedPull(job, delegatedPull, log);
        // Tell the customer what actually moved, not what was reserved. Without
        // this the result event would report the ceiling on every metered job.
        netAmount = Number(delegatedPull.chargedSubunits ?? delegatedPull.priceSubunits);
        if (outcome === 'dead') {
          // Provably no funds moved: error feedback, NO delivery, nonce stays
          // burned - the customer re-submits with a fresh proof.
          this.ledger.markFailed(job.jobId);
          await this.transport
            .sendFeedback(job, {
              type: 'error',
              message: `${DELEGATED_REJECTED_PREFIX}: the delegated transfer did not land - you were not charged. Please re-submit.`,
            })
            .catch(() => {});
          return;
        }
        if (outcome === 'unresolved') {
          // Nothing proven either way (persistent RPC failure before the
          // terminal bound). Leave the entry `paid` with its persisted pull
          // signature - the recovery loop reconciles it to a terminal and then
          // delivers or fails. Withhold the result until then.
          log(
            `[${job.jobId.slice(0, 8)}] Delegated pull unresolved before terminal; recovery will reconcile.`,
          );
          return;
        }
      }

      // NOTE: At-least-once delivery. A crash between execute() return and markExecuted()
      // flush leaves the job as 'paid' - recovery will re-execute. Skills must be idempotent
      // or tolerant of re-execution.
      this.ledger.markExecuted(job.jobId, deliveredContent);

      log(`[${job.jobId.slice(0, 8)}] Skill completed, delivering result`);

      // ── Step 6: Deliver result ──
      const eventId = await this.transport.deliverResult(
        job,
        deliveredContent,
        netAmount,
        attachments.length > 0 ? attachments : undefined,
        delegatedPull?.pullSignature,
      );
      this.ledger.markDelivered(job.jobId);

      log(`[${job.jobId.slice(0, 8)}] Delivered: ${eventId.slice(0, 16)}...`);
      // onJobCompleted is local-only (TUI/dashboard), never encrypted or delivered,
      // so it keeps the full `output.data` for operator visibility.
      this.callbacks.onJobCompleted?.(job.jobId, output.data);
    } finally {
      if (delegatedPull !== undefined) {
        this.releaseDelegationReservation(delegatedPull.request.owner, delegatedPull.priceSubunits);
      }
    }
  }

  /**
   * Decide what a delegated pull should move, for a skill that opted into
   * metered pricing.
   *
   * The skill reports a figure through `ELISYM_CHARGE_FILE`; we clamp it into
   * the range the CARD published, so the buyer can never be billed above the
   * `price` they approved nor below the `min` they were quoted. A skill that is
   * not metered, or one that reported nothing usable, charges the ceiling -
   * that is exactly today's behaviour and exactly what the buyer consented to,
   * so a provider-side bug costs the provider nothing and surprises no one.
   * The "reported nothing" case is logged loudly because on a metered skill it
   * means the script is broken, not that the job was cheap.
   *
   * Returns `undefined` to mean "charge the ceiling", which is what every
   * caller already falls back to.
   */
  private resolveMeteredCharge(
    job: IncomingJob,
    skill: Skill | null,
    ceiling: bigint,
    reported: bigint | undefined,
    log: (msg: string) => void,
  ): bigint | undefined {
    const floor = skill?.meteredMinSubunits;
    // Absent floor = not a metered skill at all: the common case, and silent.
    if (floor === undefined) {
      return undefined;
    }
    // Everything else is a malformed floor and worth saying out loud. Two
    // hazards, one branch so a flat skill never trips it:
    //  - a non-bigint would coerce through the comparisons below and reach
    //    `buildDelegatedTransfer` as a number (`meteredMinSubunits` is a plain
    //    public field, so the type annotation is the only thing asserting it);
    //  - a non-positive floor would let a zero report clamp to zero, and the
    //    transfer builder rejects that - killing the job AFTER the work ran and
    //    the result was persisted. The card path guards this too.
    if (typeof floor !== 'bigint' || floor <= 0n) {
      log(
        `[${job.jobId.slice(0, 8)}] Metered skill has an unusable floor (${String(floor)}) - ` +
          `billing the ${ceiling} ceiling.`,
      );
      return undefined;
    }
    // `chargeSubunits` is bigint by TYPE only - it crosses the skill boundary as
    // whatever the implementation put there. A number would coerce silently
    // through the comparisons below and reach `buildDelegatedTransfer` as a
    // number, so refuse anything else rather than trusting the annotation.
    if (reported !== undefined && typeof reported !== 'bigint') {
      log(
        `[${job.jobId.slice(0, 8)}] Metered skill reported a non-bigint charge - billing the ${ceiling} ceiling.`,
      );
      return undefined;
    }
    if (reported === undefined) {
      log(
        `[${job.jobId.slice(0, 8)}] Metered skill reported no charge - billing the ${ceiling} ceiling. ` +
          `The script should write its cost in subunits to ELISYM_CHARGE_FILE.`,
      );
      return undefined;
    }
    // Clamp in two UNCONDITIONAL steps, not if/else-if. The load-time invariant
    // says the floor sits under the ceiling, but this is the one line that means
    // "never more than the price the buyer approved", so it must hold even if
    // that invariant is ever broken upstream: raising to the floor first and
    // only then capping guarantees `charged <= ceiling` on every path.
    // Both bounds come from the published card, never from the skill.
    let charged = reported;
    if (charged < floor) {
      charged = floor;
    }
    if (charged > ceiling) {
      charged = ceiling;
    }
    if (charged !== reported) {
      log(
        `[${job.jobId.slice(0, 8)}] Metered charge ${reported} clamped to ${charged} ` +
          `(published range ${floor}..${ceiling}).`,
      );
    }
    return charged;
  }

  private reserveDelegation(owner: string, amount: bigint): void {
    this.delegationInFlight.set(owner, (this.delegationInFlight.get(owner) ?? 0n) + amount);
  }

  /** Saturates at zero; drops the key when the owner has nothing in flight. */
  private releaseDelegationReservation(owner: string, amount: bigint): void {
    const current = this.delegationInFlight.get(owner) ?? 0n;
    const next = current > amount ? current - amount : 0n;
    if (next === 0n) {
      this.delegationInFlight.delete(owner);
    } else {
      this.delegationInFlight.set(owner, next);
    }
  }

  /**
   * Delegated pre-check: fail-closed gates from format to funds, then the
   * atomic nonce burn, then the on-chain delegation check + per-owner
   * reservation. Returns the pull context, or `undefined` after rejecting
   * (entry marked failed + error feedback sent). Runs AFTER `recordPaid`, so
   * every reject must `markFailed` to avoid a dangling `paid` entry.
   */
  private async delegatedPreCheck(
    job: IncomingJob,
    skill: Skill | null,
    log: (msg: string) => void,
  ): Promise<DelegatedPullContext | undefined> {
    const reject = async (operatorDetail: string, customerReason: string): Promise<undefined> => {
      log(`[${job.jobId.slice(0, 8)}] Delegated payment rejected: ${operatorDetail}`);
      this.ledger.markFailed(job.jobId);
      await this.transport
        .sendFeedback(job, {
          type: 'error',
          message: `${DELEGATED_REJECTED_PREFIX}: ${customerReason}`,
        })
        .catch(() => {});
      return undefined;
    };

    if (job.delegatedRejected !== undefined || job.delegated === undefined) {
      return reject(
        `malformed delegation tags (${job.delegatedRejected ?? 'missing struct'})`,
        'malformed delegation tags.',
      );
    }
    const request = job.delegated;
    const delegateSigner = this.config.delegateSigner;
    if (delegateSigner === undefined || this.nonceStore === undefined) {
      return reject(
        'agent has no delegate key configured',
        'this agent does not accept delegated payment.',
      );
    }
    const network: Network = this.config.network;
    if (!skill || skill.delegation === undefined || skill.priceSubunits <= 0) {
      return reject(
        'skill does not accept delegated payment',
        'this skill does not accept delegated payment.',
      );
    }
    // Defense-in-depth behind the load-time USDC invariant in
    // `validateSkillFrontmatter`: the pull moves `priceSubunits` as USDC
    // subunits, so the skill asset MUST be the canonical delegation asset.
    const delegationAsset = resolveDelegationAsset(network);
    if (skill.asset.mint !== delegationAsset.mint) {
      return reject(
        `skill asset ${skill.asset.symbol} is not the delegation asset`,
        'this skill does not accept delegated payment.',
      );
    }
    if (!this.config.solanaAddress) {
      return reject(
        'no solana payment address configured',
        'this agent does not accept delegated payment.',
      );
    }

    // Expiry is a bounded deadline, not a skew tolerance: the horizon check
    // caps the phishing window; the skew clamp applies only to "now".
    const nowSecs = Math.floor(Date.now() / 1000);
    if (request.expiryUnix <= nowSecs) {
      return reject('proof expired', 'the payment proof has expired - re-submit the job.');
    }
    if (request.expiryUnix > nowSecs + MAX_PROOF_TTL_SECS + PROOF_CLOCK_SKEW_SECS) {
      return reject(
        'proof expiry beyond the allowed horizon',
        'the payment proof expiry is too far in the future.',
      );
    }

    // Verify BEFORE the nonce mark so a valid-format but unauthenticated event
    // never writes to the durable used-set.
    const proofValid = await verifyDelegationAuthProof({
      agentDelegate: delegateSigner.address,
      nostrAuthor: job.customerId,
      owner: request.owner,
      expiryUnix: request.expiryUnix,
      nonce: request.nonce,
      proof: request.proof,
    });
    if (!proofValid) {
      return reject('proof verification failed', 'invalid payment proof.');
    }

    // Atomic single-use nonce burn: ONE synchronous block, no await between
    // `has` and `markUsed` - JS single-threading then guarantees exactly-once
    // across N concurrent same-nonce events (event-id dedup cannot: each event
    // has a distinct id). The `delegated` discriminator flushes in the same
    // breath. Every failure AFTER this point leaves the nonce burned -
    // fail-closed; only the legitimately-bound author could re-present it.
    const nonceKey = `${request.owner}:${request.nonce}`;
    if (this.nonceStore.has(nonceKey)) {
      return reject('nonce already used', 'this payment proof was already used.');
    }
    this.nonceStore.markUsed(nonceKey, request.expiryUnix + PROOF_CLOCK_SKEW_SECS);
    this.ledger.markDelegated(job.jobId);

    // On-chain pre-check (async, after the mark). `deriveOwnerDelegationAta`
    // throws on a non-address owner - caught here as a clean reject, never a
    // job-loop crash.
    let ownerAta: string;
    try {
      ownerAta = await deriveOwnerDelegationAta(request.owner, network);
    } catch (error) {
      return reject(
        `owner ATA derivation failed: ${error instanceof Error ? error.message : String(error)}`,
        'invalid delegation owner address.',
      );
    }
    const rpc = createSolanaRpc(getRpcUrl(this.config.network));
    let status;
    try {
      status = await getDelegation(rpc, ownerAta);
    } catch (error) {
      return reject(
        `getDelegation failed: ${error instanceof Error ? error.message : String(error)}`,
        'could not verify the delegation on-chain - try again later.',
      );
    }
    if (status === null || status.delegate !== delegateSigner.address) {
      return reject(
        `no active delegation for this delegate (current: ${status?.delegate ?? 'none'})`,
        'no active delegation for this agent - approve it first.',
      );
    }
    const priceSubunits = BigInt(skill.priceSubunits);
    // Exclude THIS job's own (not-yet-acquired) reservation: check first, THEN
    // reserve - else the exact-cap single-job case (cap == price) would
    // falsely reject.
    const otherInFlight = this.delegationInFlight.get(request.owner) ?? 0n;
    if (status.remainingCap - otherInFlight < priceSubunits) {
      return reject(
        `remaining cap ${status.remainingCap} minus in-flight ${otherInFlight} below price ${priceSubunits}`,
        'the remaining delegated allowance is below this skill price.',
      );
    }
    if (status.balance < priceSubunits) {
      return reject(
        `owner balance ${status.balance} below price ${priceSubunits}`,
        'the delegation account balance is below this skill price.',
      );
    }
    log(
      `[${job.jobId.slice(0, 8)}] Delegated pre-check ok: ${formatAssetAmount(
        delegationAsset,
        priceSubunits,
      )} from ${request.owner.slice(0, 8)}... (pull after work)`,
    );
    // Reserve LAST, immediately before returning. The caller's try/finally -
    // the only thing that ever releases - does not open until this function
    // returns, so anything that can throw between the reservation and the
    // return (a throwing `onLog`, say) would leak the owner's ceiling in
    // `delegationInFlight` for the life of the process: that map has no GC and
    // no expiry.
    this.reserveDelegation(request.owner, priceSubunits);
    return { request, delegateSigner, ownerAta, priceSubunits, rpc, network };
  }

  /**
   * The two-phase pull - the ONLY money move of a delegated job. Phase A signs
   * and PERSISTS `{signature, lastValidBlockHeight}` (+ the amount) before any
   * bytes hit the network; phase B sends and polls to a provable terminal.
   * Never throws past phase A: the outcome routes the caller.
   */
  private async executeDelegatedPull(
    job: IncomingJob,
    ctx: DelegatedPullContext,
    log: (msg: string) => void,
  ): Promise<PullTerminalOutcome> {
    if (!this.config.solanaAddress) {
      throw new Error('Solana address not configured');
    }
    // The provider's own USDC ATA - the pinned destination of every pull.
    const destinationAta = await deriveOwnerDelegationAta(this.config.solanaAddress, ctx.network);
    // One expression for the amount, read by the transfer, the ledger and the log
    // alike - three copies that must never drift apart.
    const amount = ctx.chargedSubunits ?? ctx.priceSubunits;
    const instructions = await buildDelegatedTransfer({
      delegate: ctx.delegateSigner,
      source: ctx.ownerAta,
      destination: destinationAta,
      amount,
      network: ctx.network,
      // Idempotent create (delegate-paid rent) so a fresh provider wallet's
      // first delegated job does not dead-letter on a missing ATA.
      ensureDestination: { owner: this.config.solanaAddress },
    });
    const pull = await buildSignedPull(ctx.rpc, ctx.delegateSigner, instructions, {
      network: ctx.network,
    });
    this.ledger.recordPullSignature(
      job.jobId,
      pull.signature,
      Number(pull.lastValidBlockHeight),
      Number(amount),
    );
    ctx.pullSignature = pull.signature;
    const outcome = await sendConfirmToTerminal(ctx.rpc, pull, {});
    // Name the amount actually moved. Without it the operator's only per-job
    // figure is the pre-check line, which prints the CEILING - so every metered
    // job would be logged at a price it did not collect.
    log(
      `[${job.jobId.slice(0, 8)}] Delegated pull ${outcome}: ${amount} subunits, ` +
        `${pull.signature.slice(0, 16)}...`,
    );
    return outcome;
  }

  /**
   * Restart reconciliation of the durable used-nonce set: re-burn every nonce
   * found in persisted raw events (any status - a nonce is burned the moment
   * its event entered the ledger's delegated path; fail-closed re-covers even
   * pre-mark rejects). Runs BEFORE `transport.start`.
   */
  private reconcileUsedNonces(): void {
    if (this.nonceStore === undefined) {
      return;
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const entry of this.ledger.allEntries()) {
      if (entry.raw_event_json === undefined) {
        continue;
      }
      try {
        const parsed = parseDelegatedPayment(JSON.parse(entry.raw_event_json));
        if (parsed === null) {
          continue;
        }
        const retainUntil = parsed.expiryUnix + PROOF_CLOCK_SKEW_SECS;
        if (retainUntil <= nowSecs) {
          continue;
        }
        const key = `${parsed.owner}:${parsed.nonce}`;
        if (!this.nonceStore.has(key)) {
          this.nonceStore.markUsed(key, retainUntil, { persist: false });
          changed = true;
        }
      } catch {
        // Malformed persisted event / tags - nothing to reconcile for it.
      }
    }
    if (changed) {
      try {
        this.nonceStore.flush();
      } catch {
        /* disk full - in-memory set still enforces single-use */
      }
    }
  }

  /**
   * Delegated discriminator for recovery routing. The ledger flag is primary;
   * the persisted raw event's top-level `payment` tag is the fallback for an
   * entry whose flag write was lost.
   */
  private isDelegatedEntry(entry: { delegated?: boolean; raw_event_json?: string }): boolean {
    if (entry.delegated === true) {
      return true;
    }
    if (entry.raw_event_json === undefined) {
      return false;
    }
    try {
      const raw = JSON.parse(entry.raw_event_json) as { tags?: unknown };
      return (
        Array.isArray(raw.tags) &&
        raw.tags.some((tag) => Array.isArray(tag) && tag[0] === 'payment' && tag[1] === 'delegated')
      );
    } catch {
      return false;
    }
  }

  /**
   * Reconcile a delegated `paid` entry to its terminal - the FIRST action in
   * the recovery `paid` branch, BEFORE skill.route/health/preflight gates: a
   * renamed skill or an unhealthy LLM must never strand an already-charged
   * pull, and redelivering a persisted result needs none of them. Operates
   * purely on persisted state - never re-executes, never re-signs.
   */
  private async reconcileDelegatedEntry(
    entry: ReturnType<JobLedger['pendingJobs']>[number],
    fakeJob: IncomingJob,
    log: (msg: string) => void,
  ): Promise<void> {
    if (entry.pull_signature === undefined) {
      // No pull was ever signed: no charge occurred. The proof is single-use
      // and stale by now - fail terminally; the customer re-submits fresh.
      log(`[${entry.job_id.slice(0, 8)}] Recovery: delegated entry has no pull, marking failed`);
      this.ledger.markFailed(entry.job_id);
      await this.transport
        .sendFeedback(fakeJob, {
          type: 'error',
          message: `${DELEGATED_REJECTED_PREFIX}: the job did not complete - you were not charged. Please re-submit.`,
        })
        .catch(() => {});
      return;
    }

    const rpc = createSolanaRpc(getRpcUrl(this.config.network));
    const pullSignature = asSignature(entry.pull_signature);
    let outcome: PullTerminalOutcome;
    if (entry.pull_last_valid_block_height !== undefined) {
      outcome = await confirmPullToTerminal(
        rpc,
        pullSignature,
        BigInt(entry.pull_last_valid_block_height),
        { recheckAttempts: RECONCILE_RECHECK_ATTEMPTS },
      );
    } else {
      // Defensive: the height flushes atomically with the signature, so this
      // is unreachable in practice - but with no terminal bound the only safe
      // read is the deep history re-poll.
      outcome = (await isDefinitelyUnpaid(rpc, pullSignature, {
        recheckAttempts: RECONCILE_RECHECK_ATTEMPTS,
      }))
        ? 'dead'
        : 'assume-landed';
    }

    if (outcome === 'unresolved') {
      log(
        `[${entry.job_id.slice(0, 8)}] Recovery: delegated pull still unresolved; retrying next tick`,
      );
      return; // stays `paid`; the Fix-A exemption keeps it alive past 24h
    }
    if (outcome === 'dead') {
      log(`[${entry.job_id.slice(0, 8)}] Recovery: delegated pull provably dead, marking failed`);
      this.ledger.markFailed(entry.job_id);
      await this.transport
        .sendFeedback(fakeJob, {
          type: 'error',
          message: `${DELEGATED_REJECTED_PREFIX}: the delegated transfer did not land - you were not charged. Please re-submit.`,
        })
        .catch(() => {});
      return;
    }

    // Landed (or indeterminate => assume landed): the customer is charged, so
    // deliver the persisted result. Re-share attachments BEFORE markExecuted -
    // a gone blob must fail TERMINALLY (charged, result lost - bounded
    // residual), never stay `paid` to re-reconcile forever.
    let attachments: FileAttachment[];
    try {
      attachments = await this.reShareResultAttachments(entry);
    } catch {
      log(
        `[${entry.job_id.slice(0, 8)}] Recovery: delegated result blob unavailable, marking failed`,
      );
      this.ledger.markFailed(entry.job_id);
      // The one CHARGED terminal on this path (pull landed, result lost) must
      // not be silent - both no-charge terminals above send feedback, and
      // without a signal the customer's client waits out its own timeout never
      // learning the money moved. Include the tx so they can verify the pull.
      await this.transport
        .sendFeedback(fakeJob, {
          type: 'error',
          message: `Job permanently failed: the result could not be recovered after an agent restart. The delegated transfer landed (tx ${pullSignature}) - contact the provider to resolve.`,
        })
        .catch(() => {});
      return;
    }
    this.ledger.markExecuted(entry.job_id, entry.delivered_content ?? '');
    await this.transport.deliverResult(
      fakeJob,
      entry.delivered_content ?? '',
      entry.net_amount,
      attachments.length > 0 ? attachments : undefined,
      entry.pull_signature,
    );
    this.ledger.markDelivered(entry.job_id);
    log(`[${entry.job_id.slice(0, 8)}] Recovery: delegated pull ${outcome}, result delivered`);
  }

  /**
   * Seed a result blob through iroh, timing it and converting any failure (incl. the
   * transport's seed timeout, which also resets the wedged node) into a
   * `SeedFailedError` so the post-execute catch keeps the job `paid` for recovery
   * rather than losing the customer's paid job.
   */
  private async seedGuarded(
    jobId: string,
    kind: string,
    run: () => Promise<{ ticket: string; size: number }>,
  ): Promise<{ ticket: string; size: number }> {
    const log = this.callbacks.onLog ?? console.log;
    const started = Date.now();
    try {
      const seeded = await run();
      const elapsed = Date.now() - started;
      if (elapsed > SLOW_SEED_LOG_MS) {
        log(`[${jobId.slice(0, 8)}] iroh seed (${kind}) slow: ${elapsed}ms`);
      }
      return seeded;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(
        `[${jobId.slice(0, 8)}] iroh seed (${kind}) failed after ${Date.now() - started}ms: ${detail}`,
      );
      throw new SeedFailedError(error);
    }
  }

  /**
   * Decide how a skill's result travels: inline text, a seeded file, or seeded
   * large text. Returns the attachment descriptor (if any) PLUS the content to
   * deliver on the wire - which is the EMPTY string whenever the payload was
   * spilled to iroh (file or large text), so the encrypted result event carries
   * only the ticket and never re-trips the NIP-44 byte cap. The single
   * `deliveredContent` value must drive `markExecuted`, `deliverResult`, and the
   * recovery re-delivery alike (so a crash-recovered spill re-delivers empty too).
   * Persists the descriptor so recovery can re-share + re-deliver.
   *
   * Must run BEFORE `markExecuted` so a seed failure leaves the job `paid` and
   * recovery re-executes (rather than re-delivering a dead ticket). Runs after the
   * `skill.execute` budget window, so a slow seed never trips `max_execution_secs`.
   */
  private async buildResultAttachment(
    jobId: string,
    output: SkillOutput,
    customerPubkey: string,
    acceptedTransports: TransportKind[] | undefined,
  ): Promise<{ attachments: FileAttachment[]; deliveredContent: string }> {
    // Seed the (encrypted-Blossom) member only when the customer didn't advertise, or advertised
    // blossom. iroh is always seeded. So advertising ['iroh'] (MCP) skips the Blossom upload.
    const wantBlossom = acceptedTransports === undefined || acceptedTransports.includes('blossom');
    // One OR many file results: a skill that wrote several files to ELISYM_OUTPUT_DIR
    // yields `filePaths`; a single ELISYM_OUTPUT_FILE yields `filePath`. Treat both as a list.
    const filePaths = output.filePaths ?? (output.filePath !== undefined ? [output.filePath] : []);
    if (filePaths.length > 0) {
      // seedPath copies the bytes into the persistent iroh store, so the producer's
      // temp dir is no longer needed once seeding has been attempted (recovery
      // re-shares from the store, never the temp dir). Release it whether seeding
      // succeeds or throws (a SeedFailedError keeps the job `paid` for recovery, which
      // re-executes into a fresh temp dir) so a failure doesn't leave it behind.
      try {
        const attachments: FileAttachment[] = [];
        for (const filePath of filePaths) {
          attachments.push(
            await this.seedFileToAttachment(
              jobId,
              filePath,
              output.outputMime,
              customerPubkey,
              wantBlossom,
            ),
          );
        }
        // A file result's `output.data` is normally a small note delivered inline
        // alongside the tickets. But a skill can emit a LARGE note next to its file(s)
        // (e.g. a long summary + a generated PDF); spill it the same way the large-text
        // branch does so it never overflows the NIP-44 inline cap, which would otherwise
        // throw at encryption time and fail the whole paid job.
        let deliveredContent = output.data;
        if (utf8ByteLength(output.data) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES) {
          attachments.push(
            await this.spillTextAttachment(jobId, output.data, customerPubkey, wantBlossom),
          );
          deliveredContent = '';
        }
        this.ledger.recordAttachment(jobId, {
          resultAttachments: attachments.map((a) => JSON.stringify(a)),
        });
        return { attachments, deliveredContent };
      } finally {
        await output.cleanup?.().catch(() => {});
      }
    }

    // Large text result: spill it to iroh and deliver EMPTY content + a text/plain
    // attachment, so the customer fetches it via fetch_job_file (same as a file).
    if (utf8ByteLength(output.data) > LIMITS.MAX_ENCRYPTED_INLINE_BYTES) {
      const attachment = await this.spillTextAttachment(
        jobId,
        output.data,
        customerPubkey,
        wantBlossom,
      );
      this.ledger.recordAttachment(jobId, { resultAttachments: [JSON.stringify(attachment)] });
      return { attachments: [attachment], deliveredContent: '' };
    }

    return { attachments: [], deliveredContent: output.data };
  }

  /**
   * Seed a text note too large for inline delivery to iroh (+ encrypted Blossom when
   * wanted) and return it as a `result.txt` FileAttachment. Shared by the large-text
   * result path and the file-result path (a file result may carry an oversized note).
   */
  private async spillTextAttachment(
    jobId: string,
    text: string,
    customerPubkey: string,
    wantBlossom: boolean,
  ): Promise<FileAttachment> {
    if (!this.irohTransport) {
      throw new Error('Result is too large to deliver inline and iroh transport is unavailable.');
    }
    const iroh = this.irohTransport;
    const dataBytes = Buffer.from(text, 'utf8');
    const seeded = await this.seedGuarded(jobId, 'large-text', () => iroh.seedBytes(dataBytes));
    const transports: FileTransport[] = [{ kind: 'iroh', ticket: seeded.ticket }];
    if (wantBlossom) {
      const blossomMember = await this.seedBlossomMember(dataBytes, customerPubkey);
      if (blossomMember !== undefined) {
        transports.unshift(blossomMember);
      }
    }
    return { name: 'result.txt', size: seeded.size, mime: 'text/plain', transports };
  }

  /**
   * Seed ONE result file to iroh (+ encrypted Blossom when wanted) and build its
   * FileAttachment. A seed timeout throws SeedFailedError (job stays `paid` for
   * recovery). Shared by the single- and multi-file result paths.
   */
  private async seedFileToAttachment(
    jobId: string,
    filePath: string,
    outputMime: string | undefined,
    customerPubkey: string,
    wantBlossom: boolean,
  ): Promise<FileAttachment> {
    if (!this.irohTransport) {
      throw new Error('Skill produced a file result but iroh transport is unavailable.');
    }
    const iroh = this.irohTransport;
    const seeded = await this.seedGuarded(jobId, 'file', () => iroh.seedPath(filePath));
    // iroh is always present (the robust fallback); blossom is added (preferred, first) when
    // available + within the per-file encrypted-size cap, so web customers can fetch over HTTP.
    const transports: FileTransport[] = [{ kind: 'iroh', ticket: seeded.ticket }];
    if (wantBlossom) {
      const blossomMember = await this.seedBlossomFromPath(filePath, seeded.size, customerPubkey);
      if (blossomMember !== undefined) {
        transports.unshift(blossomMember);
      }
    }
    // The single-file producer's temp file is literally `output` (no extension); give
    // it one from the declared MIME. A producer-chosen name with an extension is kept.
    const producedName = basename(filePath);
    const name = extname(producedName)
      ? producedName
      : `${producedName}${extensionForMime(outputMime)}`;
    return { name, size: seeded.size, mime: outputMime ?? 'application/octet-stream', transports };
  }

  /**
   * Encrypt `bytes` to `recipientPubkey` and seed them to Blossom, returning a `blossom` transport
   * member - or `undefined` when blossom isn't configured, the bytes exceed the encrypted cap, or the
   * upload fails. Returning undefined (never throwing) keeps iroh as the guaranteed transport: an
   * optional second path must never fail the job.
   */
  private async seedBlossomMember(
    bytes: Uint8Array,
    recipientPubkey: string,
  ): Promise<Extract<FileTransport, { kind: 'blossom' }> | undefined> {
    if (this.blossomTransport === undefined || this.identity === undefined) {
      return undefined;
    }
    if (bytes.byteLength > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES) {
      return undefined;
    }
    try {
      return await this.blossomTransport.seedBytes({ bytes, recipientPubkey });
    } catch {
      // Blossom (incl. the nostr.build-fallback refusal) failed - deliver iroh-only this time.
      return undefined;
    }
  }

  /** Read a file (only when within the encrypted cap, to bound memory) and seed it to Blossom. */
  private async seedBlossomFromPath(
    filePath: string,
    size: number,
    recipientPubkey: string,
  ): Promise<Extract<FileTransport, { kind: 'blossom' }> | undefined> {
    if (this.blossomTransport === undefined || this.identity === undefined) {
      return undefined;
    }
    if (size > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES) {
      return undefined;
    }
    try {
      const bytes = await readFile(filePath);
      return await this.seedBlossomMember(bytes, recipientPubkey);
    } catch {
      return undefined;
    }
  }

  /**
   * Rebuild a file-result attachment for crash-recovery re-delivery: re-share the
   * blob from the persistent store to mint a fresh ticket (the original ticket's
   * direct addresses go stale across a restart). Returns undefined for a text
   * result; throws if the blob is gone (caller marks the job failed).
   */
  private async reShareResultAttachment(
    resultAttachmentJson: string | undefined,
  ): Promise<FileAttachment | undefined> {
    if (resultAttachmentJson === undefined) {
      return undefined;
    }
    if (!this.irohTransport) {
      throw new Error('Cannot recover a file result: iroh transport is unavailable.');
    }
    const stored = JSON.parse(resultAttachmentJson) as FileAttachment;
    const irohTransport = stored.transports.find(
      (transport): transport is Extract<FileTransport, { kind: 'iroh' }> =>
        transport.kind === 'iroh',
    );
    if (!irohTransport) {
      throw new Error('Stored result attachment has no iroh transport.');
    }
    const freshTicket = await this.irohTransport.reShare(irohTransport.ticket);
    // Preserve every non-iroh transport (e.g. blossom: its url/sha256/enc stay valid across a
    // restart - the blob lives on the relay, not a per-session ticket); refresh only the iroh ticket.
    const transports = stored.transports.map((transport) =>
      transport.kind === 'iroh' ? { kind: 'iroh' as const, ticket: freshTicket } : transport,
    );
    return { ...stored, transports };
  }

  /**
   * Re-share ALL of a recovered job's result attachments (multi-file aware). Prefers
   * the `result_attachments` array; falls back to the legacy single `result_attachment`.
   * A failure on ANY attachment throws (the caller marks the whole job failed - a
   * partial multi-file delivery is not a valid paid result).
   */
  private async reShareResultAttachments(entry: {
    result_attachments?: string[];
    result_attachment?: string;
  }): Promise<FileAttachment[]> {
    const stored =
      entry.result_attachments ??
      (entry.result_attachment !== undefined ? [entry.result_attachment] : []);
    const out: FileAttachment[] = [];
    for (const serialized of stored) {
      const attachment = await this.reShareResultAttachment(serialized);
      if (attachment !== undefined) {
        out.push(attachment);
      }
    }
    return out;
  }

  /**
   * Resolve a job's file/large-text input (when it carries an attachment) via iroh.
   * Only called post-payment - free + attachment is rejected in the `executeJob`
   * preflight. Two outcomes, both with a `cleanup` callback:
   *   - `text/*` within `MAX_REINLINE_TEXT_BYTES`: fetched into memory and returned
   *     as `inlineText`, transparently re-inlined into `SkillInput.data` so skills
   *     are unchanged (cleanup is a no-op - nothing on disk).
   *   - binary, or text over the ceiling: streamed to a fixed `input` name inside a
   *     unique `mkdtemp` dir (the untrusted attachment `name` never touches the path),
   *     returned as `filePath`.
   * `fetchToBytes`/`fetchToPath` enforce the real cap on the BLAKE3-verified size, so
   * an incorrect declared `size` cannot exceed the in-memory ceiling.
   */
  private async resolveInputFile(
    attachment: FileAttachment | undefined,
    senderPubkey: string,
    signal?: AbortSignal,
  ): Promise<{ inlineText?: string; filePath?: string; cleanup: () => Promise<void> } | undefined> {
    if (attachment === undefined) {
      return undefined;
    }
    // Bound the post-payment input fetch so a slow/non-responsive customer ticket or URL
    // can't hold a p-limit job slot. ONE controller drives the abort: it fires when the job
    // is aborted (stop()/shutdown via `signal`) OR the operator's execution budget elapses.
    // It is threaded into both transports - the blossom HTTP fetch aborts for real; the iroh
    // fetch abandons its JS wait (the napi binding can't cancel a native transfer mid-flight,
    // so the native download self-terminates in the background, like the timeout path).
    const fetchTimeoutMs =
      this.config.executionTimeoutSecs && this.config.executionTimeoutSecs > 0
        ? this.config.executionTimeoutSecs * 1000
        : undefined;
    const fetchAbort = new AbortController();
    const onParentAbort = (): void => fetchAbort.abort();
    if (signal) {
      if (signal.aborted) {
        fetchAbort.abort();
      } else {
        signal.addEventListener('abort', onParentAbort);
      }
    }
    const budgetTimer =
      fetchTimeoutMs !== undefined
        ? setTimeout(() => fetchAbort.abort(), fetchTimeoutMs)
        : undefined;

    try {
      const irohMember = attachment.transports.find(
        (t): t is Extract<FileTransport, { kind: 'iroh' }> => t.kind === 'iroh',
      );
      const blossomMember = attachment.transports.find(
        (t): t is Extract<FileTransport, { kind: 'blossom' }> => t.kind === 'blossom',
      );

      // Prefer iroh when available: it streams to disk with no in-memory cap. Fall back to the
      // encrypted blossom transport for web-submitted inputs that only carry a blossom member.
      if (irohMember !== undefined && this.irohTransport !== undefined) {
        if (
          attachment.mime.startsWith('text/') &&
          attachment.size <= LIMITS.MAX_REINLINE_TEXT_BYTES
        ) {
          const bytes = await this.irohTransport.fetchToBytes(irohMember.ticket, {
            maxBytes: LIMITS.MAX_REINLINE_TEXT_BYTES,
            timeoutMs: fetchTimeoutMs,
            signal: fetchAbort.signal,
          });
          return this.materializeBytesInput(bytes, attachment.mime);
        }
        const dir = await mkdtemp(join(tmpdir(), 'elisym-job-'));
        const filePath = join(dir, 'input');
        try {
          await this.irohTransport.fetchToPath(irohMember.ticket, filePath, {
            timeoutMs: fetchTimeoutMs,
            signal: fetchAbort.signal,
          });
        } catch (error) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return {
          filePath,
          cleanup: async () => {
            await rm(dir, { recursive: true, force: true });
          },
        };
      }

      if (
        blossomMember !== undefined &&
        this.blossomTransport !== undefined &&
        this.identity !== undefined
      ) {
        if (attachment.size > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES) {
          throw new Error('Blossom file input exceeds the encrypted size cap.');
        }
        const bytes = await this.blossomTransport.fetchToBytes({
          transport: blossomMember,
          senderPubkey,
          maxBytes: LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES,
          signal: fetchAbort.signal,
        });
        return this.materializeBytesInput(bytes, attachment.mime);
      }

      throw new Error('Job carries a file input but no supported transport is available.');
    } finally {
      if (budgetTimer !== undefined) {
        clearTimeout(budgetTimer);
      }
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  /**
   * Turn fetched input bytes into a SkillInput: text within the re-inline ceiling becomes an
   * in-memory string; anything else is written to a fixed `input` name inside a unique mkdtemp dir
   * (the untrusted attachment `name` never touches the path). Shared by the iroh-text and blossom
   * paths (both have the bytes in hand); the iroh-binary path streams to disk separately.
   */
  private async materializeBytesInput(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ inlineText?: string; filePath?: string; cleanup: () => Promise<void> }> {
    if (mime.startsWith('text/') && bytes.byteLength <= LIMITS.MAX_REINLINE_TEXT_BYTES) {
      return { inlineText: Buffer.from(bytes).toString('utf8'), cleanup: async () => {} };
    }
    const dir = await mkdtemp(join(tmpdir(), 'elisym-job-'));
    const filePath = join(dir, 'input');
    try {
      await writeFile(filePath, bytes);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return {
      filePath,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
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
      this.config.network,
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

    // Per-path failure outcomes, captured for the timeout-classification below. Declared
    // at method scope (not inside the executor) because the WARNING site reads them after
    // the Promise resolves. `sigOutcome.gotSignature` distinguishes "customer asserted a
    // payment we could not confirm" (loud) from "customer never paid" (calm).
    let sigOutcome: { gotSignature: boolean; error?: string } | undefined;
    let refOutcome: { error?: string } | undefined;
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
              sigOutcome = { gotSignature: false };
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
                sigOutcome = { gotSignature: true, error: reason };
                lose(verified, `sig path: not verified (${reason})`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              sigOutcome = { gotSignature: true, error: message };
              lose({ verified: false }, `sig path error: ${message}`);
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            sigOutcome = { gotSignature: false, error: message };
            lose({ verified: false }, `sig path error: ${message}`);
          });

        // Path (b) - reference path
        payment
          .verifyPayment(rpc, request, protocolConfig)
          .then((verified) => {
            if (verified.verified) {
              win(verified);
            } else {
              const reason = (verified as { error?: string }).error ?? 'unknown';
              refOutcome = { error: reason };
              lose(verified, `ref path: not verified (${reason})`);
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            refOutcome = { error: message };
            lose({ verified: false }, `ref path error: ${message}`);
          });

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

    // Timeout. Distinguish "customer simply never paid" (calm) from genuine uncertainty
    // (loud "check manually"). Calm only when the reference scan ran clean and conclusively
    // found nothing AND the customer never asserted a payment signature over Nostr. Only the
    // exact "No matching transaction found for reference key" literal is definitive-no-pay;
    // RPC/inconclusive errors and any asserted-but-unverifiable signature fall through to loud.
    const refDefinitiveNoPay =
      refOutcome?.error === 'No matching transaction found for reference key';
    const sigGotSignature = sigOutcome?.gotSignature === true;
    const customerAbandoned = !sigGotSignature && refDefinitiveNoPay;

    if (customerAbandoned) {
      log(
        `[${job.jobId.slice(0, 8)}] Payment not received; on-chain scan found no ` +
          `matching transaction - job abandoned by customer.`,
      );
    } else {
      log(
        `[${job.jobId.slice(0, 8)}] WARNING: Payment verification timed out. ` +
          `Customer may have paid on-chain. Check address ${this.config.solanaAddress} manually.`,
      );
    }
    await this.transport
      .sendFeedback(job, { type: 'error', message: 'payment timeout' })
      .catch(() => {});
    // A conclusively-abandoned customer (definitive on-chain "no transaction" + no
    // asserted signature) is a real failure - mark it failed as before. Otherwise the
    // payment may still confirm late (e.g. a lagging RPC), so throw a distinct error
    // that keeps the job `paid` for recovery to re-verify - `payment_request` was
    // already persisted above via the early `updatePayment`, so reVerifyPayment can run.
    if (customerAbandoned) {
      throw new Error('Payment timeout');
    }
    throw new PaymentTimeoutError();
  }

  /**
   * Session refs of pending `paid` entries, for the recovery pre-pass. `paid`
   * only: `executed` entries do no session work and the status-predicate
   * release would drop them at the first re-check anyway. Applies the same
   * session-path scope as live intake (encrypted-only decode + routed skill
   * with `context: true`, llm or dynamic-script mode) - a context-off or x402
   * entry parked for hours must not pin session slots for a job that never
   * touches the transcript.
   */
  private collectRecoverySessionRefs(
    pending: ReturnType<JobLedger['pendingJobs']>,
  ): RecoverySessionRef[] {
    const refs: RecoverySessionRef[] = [];
    for (const entry of pending) {
      if (entry.status !== 'paid' || entry.raw_event_json === undefined) {
        continue;
      }
      const skill = this.skills.route(entry.tags);
      if (
        !skill ||
        (skill.mode !== 'llm' && skill.mode !== 'dynamic-script') ||
        skill.context !== true
      ) {
        continue;
      }
      try {
        const rawEvent = JSON.parse(entry.raw_event_json) as {
          tags?: string[][];
          content?: string;
        };
        const encrypted =
          rawEvent.tags?.some((tag) => tag[0] === 'encrypted' && tag[1] === 'nip44') === true;
        if (!encrypted || typeof rawEvent.content !== 'string') {
          continue;
        }
        const session = decodeJobPayload(rawEvent.content).session;
        if (session !== undefined) {
          refs.push({
            jobId: entry.job_id,
            customerId: entry.customer_id,
            sessionId: session.id,
          });
        }
      } catch {
        /* malformed persisted event - the dispatch path handles/fails it */
      }
    }
    return refs;
  }

  private async recoverPendingJobs(): Promise<void> {
    const pending = this.ledger.pendingJobs().filter((e) => !this.inFlight.has(e.job_id));

    // Session pre-pass + release sweep - unconditionally at the top of every
    // tick, BEFORE the empty-pending early return: releases are needed
    // precisely when entries have left the pending set (a sweep placed after
    // the guard would be skipped forever once the last entry delivered,
    // leaking the registration for the process lifetime). Registration here,
    // synchronously and per tick, protects queued/parked paid session jobs
    // from LRU/global eviction between recovery attempts; in-job registration
    // would be too late (recovery is fire-and-forget, live intake starts while
    // recovered jobs are still queued, and a health-gate-parked entry can stay
    // `paid` for up to 24h).
    if (this.sessionStore !== undefined) {
      this.sessionStore.syncRecoveryRegistrations(
        this.collectRecoverySessionRefs(pending),
        (jobId) => this.ledger.getStatus(jobId) === 'paid',
      );
    }

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
      // `unhealthyKeys` is a per-pair set, not deduplicated by provider:
      // we use it only to decide whether to KICK refreshUnhealthy, not
      // to issue probes ourselves. The provider-dedup of probes lives
      // inside `refreshUnhealthy`. Don't re-collapse here - that would
      // mask cases where one provider's pair is `unavailable` while
      // another is `invalid`, which need different probe paths.
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
      // The retry budget gates only expensive re-EXECUTION of 'paid' entries.
      // 'executed' entries are delivery-only (a cheap relay publish of work the
      // customer already paid for) - transient relay outages must not burn the
      // result; they are bounded by the 24h expiry alone.
      const exhaustedRetries =
        entry.status === 'paid' && entry.retry_count >= this.config.recoveryMaxRetries;
      // Fix A (status-AGNOSTIC): a persisted `pull_signature` means the
      // customer was (or may have been) CHARGED by a delegated pull - only the
      // delegated pull path ever writes it, so it is a precise discriminator.
      // Force-failing such an entry on age/retries would throw away a landed
      // pull ("charged, no result"). Exempt it: an exempted `paid` entry flows
      // to the delegated reconcile, an exempted `executed` one to the existing
      // re-delivery branch. Delegated entries with NO pull signature carry no
      // charge and force-fail like any other.
      const hasPullSignature = entry.pull_signature !== undefined;
      if ((expired || exhaustedRetries) && !hasPullSignature) {
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

    try {
      if (entry.raw_event_json === undefined) {
        return;
      }
      const rawEvent = JSON.parse(entry.raw_event_json);
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
        // Re-deliver only - no LLM call, no gate check. For a file result, re-share
        // the blob from the persistent store for a fresh ticket (the stored ticket's
        // addresses go stale across a restart); if the blob is gone, fail cleanly
        // rather than deliver a dead ticket.
        this.ledger.incrementRetry(entry.job_id);
        let attachments: FileAttachment[];
        try {
          attachments = await this.reShareResultAttachments(entry);
        } catch {
          log(`[${entry.job_id.slice(0, 8)}] Recovery: result blob unavailable, marking failed`);
          this.ledger.markFailed(entry.job_id);
          // Losing an `executed` entry's result must not be silent: for paid
          // and delegated entries the customer was already charged (upfront
          // payment or a landed pull); free entries just get the same notice.
          await this.transport
            .sendFeedback(fakeJob, {
              type: 'error',
              message:
                'Job permanently failed: the result data was lost after an agent restart - contact the provider to resolve.',
            })
            .catch(() => {});
          return;
        }
        await this.transport.deliverResult(
          fakeJob,
          entry.result,
          entry.net_amount,
          attachments.length > 0 ? attachments : undefined,
          entry.pull_signature,
        );
        this.ledger.markDelivered(entry.job_id);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: re-delivered`);
      } else if (entry.status === 'paid') {
        // Fix B: delegated reconcile-and-deliver is the FIRST action - BEFORE
        // skill.route/health/preflight/incrementRetry. A renamed skill or an
        // unhealthy LLM must not strand an already-charged pull; redelivering
        // a persisted result needs neither. Also keeps delegated entries away
        // from `reVerifyPayment` (whose `payment_request` parse would throw).
        if (this.isDelegatedEntry(entry)) {
          await this.reconcileDelegatedEntry(entry, fakeJob, log);
          return;
        }
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

        // Skill preflight gate, same retry-free semantics as the health gate
        // above: skip THIS tick without burning a retry slot. For x402 this
        // is what lets an empty float WAIT for a top-up (within the 24h
        // cutoff) instead of failing an already-paid job in 5 quick retries.
        // Cache-first ordering lives inside the driver's preflight: a bought
        // result already in the idempotency cache passes trivially and is
        // then delivered by execute() without a live quote or float.
        if (skill.preflight) {
          try {
            await skill.preflight(
              {
                data: entry.input,
                inputType: entry.input_type,
                tags: entry.tags,
                jobId: entry.job_id,
              },
              this.skillCtx,
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log(
              `[${entry.job_id.slice(0, 8)}] Recovery: preflight refused (${detail}); waiting for next tick.`,
            );
            return;
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

        // Re-fetch the file input (if any) for the recovery re-execution, decoding
        // the descriptor from the persisted (decrypted) raw event. Without this the
        // recovery skill.execute would run without its file.
        let recoveryInputFile;
        let recoverySession: { id: string } | undefined;
        try {
          // Select the payload source exactly as the live handler does
          // (transport/nostr.ts): an encrypted job's decrypted envelope lives in
          // `content`, but an UNENCRYPTED job carries it in the `i` tag. Decoding
          // only from `content` would miss an unencrypted file job's attachment and
          // re-execute it with no input - producing a wrong result the customer paid for.
          const encrypted = rawEvent.tags?.some(
            (tag: string[]) => tag[0] === 'encrypted' && tag[1] === 'nip44',
          );
          const iTag = rawEvent.tags?.find((tag: string[]) => tag[0] === 'i');
          const rawInput = encrypted ? rawEvent.content : (iTag?.[1] ?? rawEvent.content);
          const decodedPayload = decodeJobPayload(rawInput);
          // Same encrypted-only session rule as the transport: the live and
          // recovery paths must not diverge on honoring a cleartext session id.
          recoverySession = encrypted ? decodedPayload.session : undefined;
          recoveryInputFile = await this.resolveInputFile(
            decodedPayload.attachment,
            entry.customer_id,
            recoveryAbort.signal,
          );
        } catch {
          log(`[${entry.job_id.slice(0, 8)}] Recovery: input file unavailable, marking failed`);
          this.ledger.markFailed(entry.job_id);
          return;
        }

        // Same per-skill execution budget as the primary path, enforced as a
        // race so a non-cooperative skill can't stall recovery past its budget.
        // On budget the race rejects with ExecutionBudgetExceededError, which
        // recoverPendingJobs logs; the entry stays paid/executed and retries on
        // the next sweep (each attempt now bounded by the budget).
        const recoveryBudgetMs = this.resolveExecutionBudgetMs(skill);
        // Resolved BEFORE the execute closure (mirrors the primary path) so
        // the closure can stamp the session id into SkillInput.
        const recoveryJobSession = this.resolveJobSession(
          { session: recoverySession, customerId: entry.customer_id },
          skill,
        );
        const runRecoveryExecution = async (history?: ChatTurn[]): Promise<SkillOutput> => {
          let budgetTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const execPromise = skill.execute(
              {
                data: recoveryInputFile?.inlineText ?? entry.input,
                inputType: entry.input_type,
                tags: entry.tags,
                jobId: entry.job_id,
                filePath: recoveryInputFile?.filePath,
                history,
                ...(recoveryJobSession !== null ? { sessionId: recoveryJobSession.sessionId } : {}),
              },
              { ...this.skillCtx, signal: recoveryAbort.signal },
            );
            execPromise.catch(() => {});
            if (recoveryBudgetMs > 0) {
              return await Promise.race([
                execPromise,
                new Promise<never>((_resolve, reject) => {
                  budgetTimer = setTimeout(() => {
                    recoveryAbort.abort();
                    reject(new ExecutionBudgetExceededError(recoveryBudgetMs));
                  }, recoveryBudgetMs);
                }),
              ]);
            }
            return await execPromise;
          } catch (err) {
            // Mirror the primary executeJob path: a billing/invalid signal raised
            // during recovery must flip the (provider, model) pair to unhealthy.
            // Otherwise a key that expires while jobs are mid-recovery is never
            // detected - the preflight gate keeps admitting NEW jobs and customers
            // keep paying for a skill that will fail, and this loop's assertReady
            // gate keeps passing so retries burn for nothing. A budget abort matches
            // neither billing nor invalid signals, so this is a no-op for it.
            this.markHealthFromExecuteError(skill, err, log, entry.job_id);
            throw err;
          } finally {
            if (budgetTimer) {
              clearTimeout(budgetTimer);
            }
            if (recoveryInputFile) {
              await recoveryInputFile.cleanup().catch(() => {});
            }
          }
        };

        // Session path, recovery flavor: same lock/open/append flow as live
        // (slot-then-mutex holds - we run inside this.limit), with one
        // deliberate difference: the history load excludes this job's own
        // recorded turns. After a post-append SeedFailedError the transcript
        // already holds this exchange; replaying it would ask the LLM the same
        // question with its own undelivered answer in the prompt, and the
        // `(jobId, role)`-deduped append skips the already-present lines.
        const output =
          recoveryJobSession === null
            ? await runRecoveryExecution()
            : await this.runSessionExchange({
                session: recoveryJobSession,
                jobId: entry.job_id,
                userRecord: buildUserRecord(
                  recoveryInputFile?.inlineText ?? entry.input,
                  recoveryInputFile?.filePath !== undefined ? 'attachment' : undefined,
                ),
                signal: recoveryAbort.signal,
                log,
                execute: runRecoveryExecution,
                excludeOwnTurns: true,
              });

        // Symmetric with the primary path: seed any spilled payload (file or large
        // text) BEFORE markExecuted, and deliver `deliveredContent` (empty when
        // spilled) so a re-executed result never re-trips the NIP-44 byte cap.
        const { attachments: resultAttachments, deliveredContent } =
          await this.buildResultAttachment(
            entry.job_id,
            output,
            entry.customer_id,
            readAcceptedTransports(rawEvent.tags),
          );
        this.ledger.markExecuted(entry.job_id, deliveredContent);
        await this.transport.deliverResult(
          fakeJob,
          deliveredContent,
          entry.net_amount,
          resultAttachments.length > 0 ? resultAttachments : undefined,
        );
        this.ledger.markDelivered(entry.job_id);
        log(`[${entry.job_id.slice(0, 8)}] Recovery: re-executed and delivered`);
      }
    } finally {
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
