/**
 * Lazy LLM recovery probe. While every registered (provider, model) pair
 * is healthy, ticks are no-ops: zero API traffic, zero billing tokens
 * burned. The loop only does real work after a pair has flipped to
 * unhealthy (via `markUnhealthyFromJob` from the runtime, or from a
 * preflight probe that returned a non-ok verification): each tick
 * re-probes only the unhealthy pairs and, on success, flips them back to
 * healthy via the monitor's normal `applyVerification` path.
 *
 * The recovery loop is the only path back to `healthy` after a reactive
 * markUnhealthy. Without it, the agent would stay locked out until
 * restart even after the operator pops their billing back up.
 *
 * Logging policy lives here so the monitor stays a pure state-machine.
 * Status transitions (healthy <-> unhealthy) are logged once per change;
 * routine successful re-probes are not logged. When the monitor's
 * provider-wide cascade (see `applyVerification` in `monitor.ts`)
 * flips multiple sibling pairs at once, each pair still produces its
 * own transition line here - intentional asymmetry vs. the runtime's
 * single aggregated "marking unhealthy" line, since each sibling is
 * separately observed by the snapshot diff.
 */

import { LAZY_RECOVERY_INTERVAL_MS } from './constants';
import type { LlmHealthMonitor } from './monitor';
import type { LlmHealthSnapshotEntry, LlmHealthStatus } from './types';

export interface HeartbeatHandle {
  stop(): void;
}

export interface StartLlmRecoveryOptions {
  monitor: LlmHealthMonitor;
  /** Defaults to {@link LAZY_RECOVERY_INTERVAL_MS} (5 minutes). */
  intervalMs?: number;
  /** Operator log sink. Defaults to no-op (silent). */
  log?: (msg: string) => void;
}

/**
 * @deprecated Renamed to {@link StartLlmRecoveryOptions}. Kept as an alias
 * so external consumers keep building during the rename. The semantics
 * have changed (lazy, recovery-only) but the option surface is identical.
 */
export type StartLlmHeartbeatOptions = StartLlmRecoveryOptions;

type IntervalHandle = ReturnType<typeof setInterval>;

const NOOP_LOG = (_msg: string): void => {};

function isHealthyState(status: LlmHealthStatus): boolean {
  return status === 'healthy' || status === 'unknown';
}

function describeTransition(
  prev: LlmHealthStatus,
  next: LlmHealthSnapshotEntry,
): string | undefined {
  const wasHealthy = isHealthyState(prev);
  const nowHealthy = isHealthyState(next.status);
  if (wasHealthy === nowHealthy) {
    return undefined;
  }
  if (wasHealthy && !nowHealthy) {
    const reason = next.lastReason ?? next.status;
    return `! LLM provider ${next.provider} model ${next.model} became unhealthy: ${next.status} (${reason}). Refusing LLM jobs until recovered.`;
  }
  return `* LLM provider ${next.provider} model ${next.model} recovered.`;
}

/**
 * Start the lazy recovery loop. Returns a handle whose `stop()` cancels
 * the timer (idempotent). The loop ticks every `intervalMs` ms; each
 * tick scans `monitor.snapshot()` and, if any pair is non-healthy, asks
 * the monitor to re-probe just those non-healthy pairs via
 * `refreshUnhealthy()`. Healthy pairs are never re-probed by the loop -
 * those keep their cached `healthy` until TTL expiry forces a probe at
 * the next `assertReady` call. When all pairs are healthy the tick is a
 * single Map walk and no API calls are made.
 *
 * The function is named `startLlmRecovery` but the legacy export
 * `startLlmHeartbeat` (below) is preserved as an alias so external
 * code that already imports it keeps working unchanged.
 */
export function startLlmRecovery(options: StartLlmRecoveryOptions): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? LAZY_RECOVERY_INTERVAL_MS;
  const log = options.log ?? NOOP_LOG;

  let lastStatusByPair = new Map<string, LlmHealthStatus>();
  for (const entry of options.monitor.snapshot()) {
    lastStatusByPair.set(`${entry.provider}::${entry.model}`, entry.status);
  }

  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const before = options.monitor.snapshot();
    const anyUnhealthy = before.some((entry) => !isHealthyState(entry.status));
    if (!anyUnhealthy) {
      // Lazy: nothing to do. Refreshing healthy pairs would burn one
      // billing-token per pair per tick for no benefit (the monitor's
      // own TTL would re-probe at assertReady time anyway).
      return;
    }

    let snapshot: readonly LlmHealthSnapshotEntry[];
    try {
      snapshot = await options.monitor.refreshUnhealthy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`! LLM recovery probe failed: ${message}`);
      return;
    }

    const next = new Map<string, LlmHealthStatus>();
    for (const entry of snapshot) {
      const key = `${entry.provider}::${entry.model}`;
      const prev = lastStatusByPair.get(key) ?? 'unknown';
      const transitionMessage = describeTransition(prev, entry);
      if (transitionMessage) {
        log(transitionMessage);
      }
      next.set(key, entry.status);
    }
    lastStatusByPair = next;
  };

  const handle: IntervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(handle);
    },
  };
}

/**
 * @deprecated Renamed to {@link startLlmRecovery}. The old name is
 * preserved as an alias so existing imports keep working during the
 * rename. Behavior changed materially: the new loop is lazy
 * (no API calls while all pairs are healthy) and defaults to
 * `LAZY_RECOVERY_INTERVAL_MS` (5 min) instead of 10 min.
 */
export const startLlmHeartbeat = startLlmRecovery;
