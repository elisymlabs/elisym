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
 *   error). May resolve on retry. `status` carries the HTTP status when the
 *   failure was an HTTP response (absent for a network throw), letting callers
 *   distinguish a transient 5xx/429 from a permanent 404 "model no longer
 *   exists" without re-parsing `error`. Unlike `invalid`/`billing`,
 *   `unavailable` is per-model and never cascades to sibling models.
 */
export type LlmKeyVerification =
  | { ok: true }
  | { ok: false; reason: 'invalid'; status: number; body: string }
  | { ok: false; reason: 'billing'; status?: number; body?: string }
  | { ok: false; reason: 'unavailable'; status?: number; error: string };

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
 * Thrown by the SDK script skills when a tool/script fails (non-zero exit, spawn
 * error, or exit 0 with empty output).
 *
 * NOTHING on this error is customer-facing. `message` is a fixed summary
 * (`script failed (exit 1)`, `script produced empty output`) written for a log,
 * and the runtime masks every script crash with one sentence of its own rather
 * than forwarding it - an exit code and an internal phrase tell a buyer nothing
 * and tell an attacker something. `detail` carries the raw stderr/stdout for the
 * operator log and the health classifier ONLY.
 */
export class ScriptExecutionError extends Error {
  readonly exitCode: number | null;
  readonly detail: string;
  /**
   * The script's stderr alone, when the runner had it to give.
   *
   * Kept apart from `detail` (which falls back to stdout) because the runtime
   * scans this text for billing/auth markers to decide whether to gate an API
   * key. Stdout is frequently NOT the script's own words - an LLM proxy echoes
   * a completion the customer steers - so a buyer could otherwise ask for the
   * word "unauthorized" and take the agent's whole provider offline.
   */
  readonly stderr: string | undefined;
  constructor(exitCode: number | null, detail: string, summary?: string, stderr?: string) {
    super(summary ?? `script failed (exit ${exitCode ?? 'unknown'})`);
    this.name = 'ScriptExecutionError';
    this.exitCode = exitCode;
    this.detail = detail;
    this.stderr = stderr;
  }
}

/**
 * Type guards by name rather than `instanceof`.
 *
 * The SDK builds each entry point as its own bundle (`splitting: false`), so
 * the copy of these classes inside `@elisym/sdk/skills` - the one the script
 * runners actually throw - is a different class object from the one exported
 * here. `instanceof` across the two is false however the source reads, which
 * silently cost the runtime its `detail` (the raw stderr) on every script
 * failure. Consumers outside this module should use these.
 */
export function isLlmHealthError(value: unknown): value is LlmHealthError {
  return (
    value instanceof Error &&
    value.name === 'LlmHealthError' &&
    typeof (value as LlmHealthError).reason === 'string'
  );
}

export function isScriptExecutionError(value: unknown): value is ScriptExecutionError {
  return (
    value instanceof Error &&
    value.name === 'ScriptExecutionError' &&
    typeof (value as ScriptExecutionError).detail === 'string'
  );
}

export function isScriptBillingExhaustedError(
  value: unknown,
): value is ScriptBillingExhaustedError {
  // BOTH streams, because both are read: a guard that vouches for one field
  // and lets a caller dereference the other throws a TypeError inside the
  // catch handler that was supposed to close the job - and the customer is
  // then told nothing at all.
  return (
    value instanceof Error &&
    value.name === 'ScriptBillingExhaustedError' &&
    typeof (value as ScriptBillingExhaustedError).stderr === 'string' &&
    typeof (value as ScriptBillingExhaustedError).stdout === 'string'
  );
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
