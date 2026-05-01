/**
 * Shared types for the LLM health monitor. Provider-agnostic: the
 * actual HTTP probe lives in CLI/plugin and is supplied via dependency
 * injection (`verifyFn`).
 */

export type LlmHealthStatus = 'unknown' | 'healthy' | 'invalid' | 'billing' | 'unavailable';

/**
 * Result of probing an API key with a specific model. Discriminated on
 * `ok`, then on `reason` for failures. Adding a new failure reason is a
 * breaking change for exhaustive switches; update consumers in lockstep.
 *
 * - `invalid`: HTTP 401/403 - key rejected outright.
 * - `billing`: HTTP 402, or 400 with credit/billing/insufficient marker,
 *   or OpenAI's 429 with `insufficient_quota`. Operator out of credits.
 * - `unavailable`: transient (HTTP 429 without quota marker, 5xx, network
 *   error). May resolve on retry.
 */
export type LlmKeyVerification =
  | { ok: true }
  | { ok: false; reason: 'invalid'; status: number; body: string }
  | { ok: false; reason: 'billing'; status?: number; body?: string }
  | { ok: false; reason: 'unavailable'; error: string };

export type LlmHealthErrorReason = 'invalid' | 'billing' | 'unavailable';

/**
 * Thrown by `LlmHealthMonitor.assertReady` when the gate refuses a job.
 * Carries the operator-facing reason so callers can log it; customer-facing
 * messages should be sanitized at the call site (see `runtime.ts` preflight).
 */
export class LlmHealthError extends Error {
  readonly reason: LlmHealthErrorReason;
  readonly provider: string;
  readonly model: string;

  constructor(reason: LlmHealthErrorReason, provider: string, model: string, detail: string) {
    super(`LLM ${provider}/${model} ${reason}: ${detail}`);
    this.name = 'LlmHealthError';
    this.reason = reason;
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Thrown by SDK script skills (`static-script`, `dynamic-script`) when the
 * spawned process exits with `SCRIPT_EXIT_BILLING_EXHAUSTED` (= 42). The
 * runtime catches this and calls `markUnhealthyFromJob` on the matching
 * (provider, model) pair declared in SKILL.md, so subsequent jobs are
 * gated until the lazy recovery loop re-probes the key. The exit code is
 * the script-side equivalent of the LLM-mode 402 path.
 *
 * The error does NOT carry provider/model itself - the script doesn't
 * know which pair the agent registered with the monitor; the runtime
 * reads them from the matched skill's `llmOverride` declaration.
 */
export class ScriptBillingExhaustedError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;

  constructor(exitCode: number, stdout: string, stderr: string) {
    const detail = stderr.trim() || stdout.trim() || '(no output)';
    super(`script exited with billing-exhausted code ${exitCode}: ${detail}`);
    this.name = 'ScriptBillingExhaustedError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Per-skill rate-limit declaration. Snake-case in SKILL.md frontmatter,
 * camelCase here. Applies to any skill mode but the framework adds a
 * default cap only for free LLM skills.
 */
export interface SkillRateLimit {
  perWindowMs: number;
  maxPerWindow: number;
}

/** Read-only health snapshot for logs/tests. */
export interface LlmHealthSnapshotEntry {
  provider: string;
  model: string;
  status: LlmHealthStatus;
  lastVerifiedAt: number;
  lastReason: string | undefined;
  consecutiveFailures: number;
}
