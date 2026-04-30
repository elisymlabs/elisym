/**
 * Periodic LLM health probe. Stops on demand. Logs status transitions
 * (healthy <-> unhealthy) but does not log every successful tick to keep
 * the operator log quiet.
 *
 * The heartbeat pure-delegates to `monitor.refreshAll()`; both timing and
 * logging policy live here so the monitor stays a pure state-machine.
 */

import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './constants';
import type { LlmHealthMonitor } from './monitor';
import type { LlmHealthSnapshotEntry, LlmHealthStatus } from './types';

export interface HeartbeatHandle {
  stop(): void;
}

export interface StartLlmHeartbeatOptions {
  monitor: LlmHealthMonitor;
  /** Defaults to 5 minutes. */
  intervalMs?: number;
  /** Operator log sink. Defaults to no-op (silent). */
  log?: (msg: string) => void;
}

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

export function startLlmHeartbeat(options: StartLlmHeartbeatOptions): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const log = options.log ?? NOOP_LOG;

  let lastStatusByPair = new Map<string, LlmHealthStatus>();
  for (const entry of options.monitor.snapshot()) {
    lastStatusByPair.set(`${entry.provider}|${entry.model}`, entry.status);
  }

  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    let snapshot: readonly LlmHealthSnapshotEntry[];
    try {
      snapshot = await options.monitor.refreshAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`! LLM heartbeat refreshAll failed: ${message}`);
      return;
    }
    const next = new Map<string, LlmHealthStatus>();
    for (const entry of snapshot) {
      const key = `${entry.provider}|${entry.model}`;
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
