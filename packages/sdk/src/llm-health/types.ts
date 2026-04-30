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
