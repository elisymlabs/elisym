/**
 * Provider-agnostic health monitor for LLM API keys. State machine per
 * (provider, model) pair: caches the last verification result for
 * `ttlMs`, deduplicates concurrent probes via an in-flight promise, and
 * tolerates a bounded number of consecutive `unavailable` results
 * before `assertReady` starts throwing.
 *
 * The monitor itself never touches the network. Each pair must be
 * registered with a `verifyFn` lambda that performs the actual probe;
 * callers (CLI/plugin) supply provider-specific HTTP from their layer.
 */

import {
  DEFAULT_HEALTH_TTL_MS,
  UNAVAILABLE_TOLERANCE as DEFAULT_UNAVAILABLE_TOLERANCE,
} from './constants';
import {
  LlmHealthError,
  type LlmHealthSnapshotEntry,
  type LlmHealthStatus,
  type LlmKeyVerification,
} from './types';

export type LlmKeyVerifyFn = (signal?: AbortSignal) => Promise<LlmKeyVerification>;

export interface LlmHealthMonitorOptions {
  /** Time after which a cached `healthy` result is re-probed. Default 10 min. */
  ttlMs?: number;
  /** Number of consecutive unavailable results tolerated. Default 3. */
  unavailableTolerance?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export interface RegisterArgs {
  provider: string;
  model: string;
  verifyFn: LlmKeyVerifyFn;
}

interface Entry {
  provider: string;
  model: string;
  verifyFn: LlmKeyVerifyFn;
  status: LlmHealthStatus;
  lastVerifiedAt: number;
  lastReason: string | undefined;
  inFlight: Promise<LlmKeyVerification> | null;
  consecutiveFailures: number;
}

function keyOf(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function reasonDetail(verification: LlmKeyVerification): string {
  if (verification.ok) {
    return 'ok';
  }
  if (verification.reason === 'invalid') {
    return `HTTP ${verification.status}: ${verification.body.slice(0, 200)}`;
  }
  if (verification.reason === 'billing') {
    const status = verification.status ?? 0;
    const body = (verification.body ?? '').slice(0, 200);
    return `HTTP ${status}: ${body}`;
  }
  return verification.error;
}

export class LlmHealthMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly unavailableTolerance: number;
  private readonly now: () => number;

  constructor(options: LlmHealthMonitorOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEALTH_TTL_MS;
    this.unavailableTolerance = options.unavailableTolerance ?? DEFAULT_UNAVAILABLE_TOLERANCE;
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a (provider, model) pair with its probe function. Idempotent
   * on the (provider, model) key: re-registering replaces the verifyFn
   * and resets state to `unknown`. Callers typically re-register only
   * when the operator rotates the API key.
   */
  register(args: RegisterArgs): void {
    const key = keyOf(args.provider, args.model);
    this.entries.set(key, {
      provider: args.provider,
      model: args.model,
      verifyFn: args.verifyFn,
      status: 'unknown',
      lastVerifiedAt: 0,
      lastReason: undefined,
      inFlight: null,
      consecutiveFailures: 0,
    });
  }

  /**
   * Seed the monitor with an already-known verification result, e.g.
   * the one captured at startup. Skips an extra probe on the first
   * `assertReady` call within the TTL window. No-op if the pair is not
   * registered.
   *
   * In production `seed` is only called from the CLI startup path, which
   * itself `process.exit(1)`s on `invalid` / `billing` before any other
   * pair is reached - so the cascade in `applyVerification` is benign at
   * startup. In tests, seeding `invalid` / `billing` will cascade across
   * sibling pairs of the same provider, which matches the production
   * runtime behavior we want to assert.
   */
  seed(provider: string, model: string, verification: LlmKeyVerification): void {
    const entry = this.entries.get(keyOf(provider, model));
    if (!entry) {
      return;
    }
    this.applyVerification(entry, verification);
  }

  /**
   * Main gate before doing LLM work. Throws `LlmHealthError` on terminal
   * states (`invalid`, `billing`, or `unavailable` past tolerance);
   * resolves silently on `healthy` (cache hit or fresh probe) or
   * tolerated `unavailable`.
   *
   * Concurrent `assertReady` calls for the same pair are deduplicated:
   * the second caller awaits the first probe rather than launching a
   * parallel one.
   */
  async assertReady(provider: string, model: string): Promise<void> {
    const entry = this.entries.get(keyOf(provider, model));
    if (!entry) {
      throw new LlmHealthError('invalid', provider, model, 'pair not registered');
    }

    const verification = await this.probeIfNeeded(entry);

    if (verification.ok) {
      return;
    }
    if (verification.reason === 'invalid' || verification.reason === 'billing') {
      throw new LlmHealthError(verification.reason, provider, model, reasonDetail(verification));
    }
    if (entry.consecutiveFailures >= this.unavailableTolerance) {
      throw new LlmHealthError('unavailable', provider, model, reasonDetail(verification));
    }
    // Tolerated unavailable: caller proceeds, real LLM call will surface
    // any transient issue with its own error path.
  }

  /**
   * Force the next `assertReady` for this pair to re-probe regardless of
   * TTL. Used when a real LLM call surfaces 401/402 mid-job - the cached
   * `healthy` is stale and we want to catch the next request.
   *
   * NOTE: this method has no callers in the current production code
   * (`packages/sdk/src` and `packages/cli/src` both prefer the explicit
   * `markUnhealthyFromJob` below). It does NOT propagate to sibling
   * pairs; if reintroduced, consider whether the cascade in
   * `markUnhealthyFromJob` should also apply here.
   */
  markFailureFromJob(provider: string, model: string): void {
    const entry = this.entries.get(keyOf(provider, model));
    if (!entry) {
      return;
    }
    entry.lastVerifiedAt = 0;
  }

  /**
   * Reactively flip a (provider, model) pair to unhealthy without doing a
   * fresh probe. Called from the runtime when a job's actual LLM call (or
   * a script's `SCRIPT_EXIT_BILLING_EXHAUSTED` exit) surfaces a billing /
   * invalid signal: the cached `healthy` snapshot is wrong and we want
   * subsequent `assertReady` calls to refuse jobs immediately, before the
   * lazy recovery loop notices on its own. No-op if the pair is not
   * registered.
   *
   * For `invalid` / `billing` reasons this propagates to every sibling
   * pair sharing the same `provider` via the cascade in
   * `applyVerification` - they share the same API key, so a revoked or
   * exhausted key affects all models. `unavailable` stays per-pair.
   *
   * Recovery from this state happens through a successful probe (typically
   * fired by `startLlmRecovery`) which flips the pair back to healthy via
   * `applyVerification`. The recovery cascade lifts sibling pairs at the
   * same time so the gate doesn't stay half-broken.
   */
  markUnhealthyFromJob(
    provider: string,
    model: string,
    reason: 'billing' | 'invalid' | 'unavailable',
    detail?: string,
  ): void {
    const entry = this.entries.get(keyOf(provider, model));
    if (!entry) {
      return;
    }
    if (reason === 'invalid') {
      this.applyVerification(entry, {
        ok: false,
        reason: 'invalid',
        status: 0,
        body: detail ?? 'reactive markUnhealthyFromJob',
      });
      return;
    }
    if (reason === 'billing') {
      this.applyVerification(entry, {
        ok: false,
        reason: 'billing',
        body: detail ?? 'reactive markUnhealthyFromJob',
      });
      return;
    }
    this.applyVerification(entry, {
      ok: false,
      reason: 'unavailable',
      error: detail ?? 'reactive markUnhealthyFromJob',
    });
  }

  /**
   * Refresh every registered pair concurrently. Errors thrown by
   * `verifyFn` are caught and recorded as `unavailable`.
   */
  async refreshAll(): Promise<readonly LlmHealthSnapshotEntry[]> {
    const probes: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      probes.push(this.probe(entry).then(() => undefined));
    }
    await Promise.all(probes);
    return this.snapshot();
  }

  /**
   * Refresh only the pairs whose current status is non-healthy
   * (`invalid`, `billing`, or `unavailable`). Used by the lazy recovery
   * loop so a billing outage on one provider does not trigger throwaway
   * probes on every other healthy pair the agent has registered.
   * Errors thrown by `verifyFn` are caught and recorded as `unavailable`.
   *
   * Provider-deduplicated for `invalid` / `billing`: every pair under
   * the same provider shares the same API key, so a single probe per
   * provider is enough - a successful result will cascade to siblings
   * via the recovery cascade in `applyVerification`. Without this dedup,
   * a 3-skill Anthropic agent in a billing outage would burn 3x the
   * billing-token quota per recovery tick.
   *
   * `unavailable` entries probe individually because the failure is
   * model-specific (e.g. one endpoint returning 5xx) and cascading the
   * result would corrupt sibling state.
   */
  async refreshUnhealthy(): Promise<readonly LlmHealthSnapshotEntry[]> {
    const probes: Array<Promise<void>> = [];
    const sharedKeyProviders = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.status === 'healthy' || entry.status === 'unknown') {
        continue;
      }
      if (entry.status === 'unavailable') {
        probes.push(this.probe(entry).then(() => undefined));
        continue;
      }
      // invalid / billing - probe one representative per provider only.
      if (sharedKeyProviders.has(entry.provider)) {
        continue;
      }
      sharedKeyProviders.add(entry.provider);
      probes.push(this.probe(entry).then(() => undefined));
    }
    await Promise.all(probes);
    return this.snapshot();
  }

  /** Read-only view, primarily for logs and tests. */
  snapshot(): readonly LlmHealthSnapshotEntry[] {
    const out: LlmHealthSnapshotEntry[] = [];
    for (const entry of this.entries.values()) {
      out.push({
        provider: entry.provider,
        model: entry.model,
        status: entry.status,
        lastVerifiedAt: entry.lastVerifiedAt,
        lastReason: entry.lastReason,
        consecutiveFailures: entry.consecutiveFailures,
      });
    }
    return out;
  }

  private probeIfNeeded(entry: Entry): Promise<LlmKeyVerification> {
    if (entry.inFlight) {
      return entry.inFlight;
    }
    const fresh = this.now() - entry.lastVerifiedAt < this.ttlMs;
    if (fresh) {
      if (entry.status === 'healthy') {
        return Promise.resolve({ ok: true });
      }
      // Terminal failure states (`invalid`, `billing`) are cached
      // aggressively: once the operator's key is rejected or out of
      // credits, the lazy recovery loop is the only path back to healthy.
      // Re-probing on every `assertReady` would burn one billing token
      // per job rejected during a billing outage, which defeats the
      // gate's whole purpose. `unavailable` is treated as transient and
      // falls through so the existing tolerance counter still works
      // (each call re-probes, increments `consecutiveFailures`, and
      // crosses the threshold on the configured number of attempts).
      // `unknown` also falls through - a freshly registered pair that
      // was never seeded should probe on first ask.
      if (entry.status === 'invalid' || entry.status === 'billing') {
        return Promise.resolve(this.synthesizeFailureFromCache(entry));
      }
    }
    return this.probe(entry);
  }

  private synthesizeFailureFromCache(entry: Entry): LlmKeyVerification {
    const detail = entry.lastReason ?? 'cached failure';
    if (entry.status === 'invalid') {
      return { ok: false, reason: 'invalid', status: 0, body: detail };
    }
    // 'billing' (only other status reachable here)
    return { ok: false, reason: 'billing', body: detail };
  }

  private probe(entry: Entry): Promise<LlmKeyVerification> {
    if (entry.inFlight) {
      return entry.inFlight;
    }
    const promise = (async (): Promise<LlmKeyVerification> => {
      try {
        return await entry.verifyFn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: 'unavailable', error: message };
      }
    })().then((verification) => {
      this.applyVerification(entry, verification);
      entry.inFlight = null;
      return verification;
    });
    entry.inFlight = promise;
    return promise;
  }

  /**
   * Apply a verification to a single entry AND cascade across siblings
   * sharing the same `provider`. Two symmetric cascades:
   *
   * - **Failure cascade** (`invalid` / `billing`): a revoked or
   *   billing-exhausted API key affects every model the operator could
   *   reach with that key. Structurally enforced by
   *   `resolveProviderApiKey` in `packages/cli/src/llm/keys.ts:27`,
   *   which returns at most one key per provider (no per-skill
   *   injection). If a future change introduces per-skill keys, this
   *   cascade must be revisited.
   *
   * - **Recovery cascade** (`ok: true`): when a healthy verification
   *   arrives (typically from `refreshUnhealthy` after the operator
   *   fixed the key), lift sibling pairs that were stuck `invalid` /
   *   `billing` so the next `assertReady` for any model under this
   *   provider stops refusing jobs. Without this, the gate would stay
   *   half-broken until each sibling's own probe round-trips.
   *
   * `unavailable` does NOT cascade - it is treated as a transient,
   * model-specific issue (e.g. specific endpoint returning 5xx).
   *
   * Cascaded sibling verifications are tagged with `(cascaded from
   * <triggering-model>)` in their body so `snapshot()` and operator
   * logs remain diagnosable.
   */
  private applyVerification(entry: Entry, verification: LlmKeyVerification): void {
    this.mutateEntry(entry, verification);

    if (verification.ok) {
      for (const sibling of this.entries.values()) {
        if (sibling === entry) {
          continue;
        }
        if (sibling.provider !== entry.provider) {
          continue;
        }
        if (sibling.status !== 'invalid' && sibling.status !== 'billing') {
          continue;
        }
        this.mutateEntry(sibling, { ok: true });
      }
      return;
    }

    if (verification.reason !== 'invalid' && verification.reason !== 'billing') {
      return;
    }

    const cascaded = this.tagCascaded(verification, entry.model);
    for (const sibling of this.entries.values()) {
      if (sibling === entry) {
        continue;
      }
      if (sibling.provider !== entry.provider) {
        continue;
      }
      this.mutateEntry(sibling, cascaded);
    }
  }

  /**
   * Per-entry state transition. Used by `applyVerification` (which then
   * orchestrates the cascade) and by the cascade loop itself for sibling
   * entries (which must NOT trigger a recursive cascade).
   */
  private mutateEntry(entry: Entry, verification: LlmKeyVerification): void {
    entry.lastVerifiedAt = this.now();
    if (verification.ok) {
      entry.status = 'healthy';
      entry.lastReason = undefined;
      entry.consecutiveFailures = 0;
      return;
    }
    entry.lastReason = reasonDetail(verification);
    if (verification.reason === 'unavailable') {
      entry.status = 'unavailable';
      entry.consecutiveFailures += 1;
      return;
    }
    entry.status = verification.reason;
    entry.consecutiveFailures = 0;
  }

  private tagCascaded(verification: LlmKeyVerification, fromModel: string): LlmKeyVerification {
    const tag = `(cascaded from ${fromModel})`;
    if (verification.ok) {
      return verification;
    }
    if (verification.reason === 'invalid') {
      return {
        ok: false,
        reason: 'invalid',
        status: verification.status,
        body: verification.body ? `${verification.body} ${tag}` : tag,
      };
    }
    if (verification.reason === 'billing') {
      const body = verification.body ? `${verification.body} ${tag}` : tag;
      return verification.status !== undefined
        ? { ok: false, reason: 'billing', status: verification.status, body }
        : { ok: false, reason: 'billing', body };
    }
    return verification;
  }
}
