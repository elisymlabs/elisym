/**
 * Watchdog - periodically verifies relay connectivity and subscription liveness,
 * rebuilds the Nostr pool and re-subscribes on failure.
 *
 * Works around a nostr-tools bug where a single WS error sets `skipReconnection=true`
 * and silently kills long-lived subscriptions for the rest of the process
 * (see `NostrPool.reset` in @elisym/sdk).
 *
 * Three independent triggers force a pool reset:
 * - `probe`: cheap `querySync` round-trip against relays.
 * - `self-ping`: full subscribeToPings -> sendPong round-trip via the agent's
 *   own identity, catches the case where probe passes (fresh query works) but
 *   the live subscription is already dead.
 * - `sleep-detect`: if the wall-clock gap between two consecutive ticks exceeds
 *   `min(probeInterval, selfPingInterval) * SLEEP_DETECT_MULTIPLIER`, the host
 *   was almost certainly suspended (macOS sleep, hibernation, container pause).
 *   On suspend the WebSocket connections die from the relay side, but the next
 *   probe may still pass via a freshly opened query - meanwhile the long-lived
 *   ping subscription stays dead. Forcing a reset on the first post-suspend
 *   tick avoids that window.
 */
import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import type { Logger } from 'pino';
import {
  WATCHDOG_PROBE_INTERVAL_MS,
  WATCHDOG_PROBE_TIMEOUT_MS,
  WATCHDOG_SELF_PING_INTERVAL_MS,
  WATCHDOG_SELF_PING_TIMEOUT_MS,
  WATCHDOG_SLEEP_DETECT_MULTIPLIER,
} from './helpers.js';
import type { NostrTransport } from './transport/nostr.js';

export interface WatchdogDeps {
  client: ElisymClient;
  identity: ElisymIdentity;
  transport: NostrTransport;
  onPing: (senderPubkey: string, nonce: string) => void;
  log: (message: string) => void;
  /** Optional structured logger for pool-reset and probe events. */
  logger?: Logger;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  selfPingIntervalMs?: number;
  selfPingTimeoutMs?: number;
  /**
   * Optional `Date.now`-style provider. Tests inject a controlled clock to
   * simulate macOS sleep without firing intermediate `setInterval` callbacks
   * (see watchdog.test.ts). Production should leave this unset.
   */
  now?: () => number;
}

export interface Watchdog {
  stop(): void;
}

export function startWatchdog(deps: WatchdogDeps): Watchdog {
  const {
    client,
    identity,
    transport,
    onPing,
    log,
    logger,
    probeIntervalMs = WATCHDOG_PROBE_INTERVAL_MS,
    probeTimeoutMs = WATCHDOG_PROBE_TIMEOUT_MS,
    selfPingIntervalMs = WATCHDOG_SELF_PING_INTERVAL_MS,
    selfPingTimeoutMs = WATCHDOG_SELF_PING_TIMEOUT_MS,
    now = Date.now,
  } = deps;

  let pingSub: SubCloser = client.ping.subscribeToPings(identity, onPing);
  let stopped = false;
  // Separate flags: a slow probe must not suppress the self-ping that follows,
  // since they exercise different layers (short query vs. live subscription).
  let probeBusy = false;
  let selfPingBusy = false;
  let lastTickAt = now();

  const sleepDetectThresholdMs =
    Math.min(probeIntervalMs, selfPingIntervalMs) * WATCHDOG_SLEEP_DETECT_MULTIPLIER;

  // Must stay synchronous. Each timer callback checks `stopped` AFTER awaiting
  // probe/ping and BEFORE calling this function. As long as this function is
  // synchronous, it runs atomically - stop() cannot interleave between tearing
  // down old subscriptions and creating new ones. Any `await` inside would open
  // a window where stop() sets `stopped=true`, then after the await we resurrect
  // subscriptions and leak them for the rest of the process lifetime.
  const resetPoolAndResubscribe = (): void => {
    transport.stop();
    // pool.reset() also closes pingSub as part of its activeSubscriptions
    // teardown, so an explicit pingSub.close() here would be redundant.
    client.pool.reset();
    pingSub = client.ping.subscribeToPings(identity, onPing);
    transport.restart();
  };

  /**
   * Returns `true` if a wall-clock gap larger than the configured threshold
   * was observed since the last tick - in which case it has already forced a
   * pool reset and the caller should skip its normal health check. Each tick
   * (probe and self-ping) updates the shared `lastTickAt`, so consecutive
   * normal ticks see a gap close to one interval.
   */
  const detectAndHandleSleep = (): boolean => {
    const tickedAt = now();
    const delta = tickedAt - lastTickAt;
    lastTickAt = tickedAt;
    if (delta <= sleepDetectThresholdMs) {
      return false;
    }
    log(
      `[watchdog] tick gap ${delta}ms exceeds ${sleepDetectThresholdMs}ms threshold, ` +
        `forcing pool reset (host suspend / sleep detected)`,
    );
    logger?.info({ event: 'pool_reset', reason: 'sleep_detected', gapMs: delta }, 'pool reset');
    resetPoolAndResubscribe();
    return true;
  };

  const probeTimer = setInterval(async () => {
    if (stopped) {
      return;
    }
    if (detectAndHandleSleep()) {
      return;
    }
    if (probeBusy) {
      return;
    }
    probeBusy = true;
    try {
      const ok = await client.pool.probe(probeTimeoutMs);
      if (stopped || ok) {
        return;
      }
      log('[watchdog] relay probe failed, resetting pool and re-subscribing');
      logger?.info({ event: 'pool_reset', reason: 'probe_failed' }, 'pool reset');
      resetPoolAndResubscribe();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[watchdog] probe/reset error: ${errorMessage}`);
      logger?.warn({ event: 'probe_error', error: errorMessage }, 'watchdog probe/reset error');
    } finally {
      probeBusy = false;
    }
  }, probeIntervalMs);

  // CRITICAL: PingService caches "online" results for PING_CACHE_TTL_MS (30s in SDK).
  // `selfPingIntervalMs` MUST stay greater than that cache TTL, otherwise pingAgent
  // will keep returning cached `online: true` and the watchdog will never detect a
  // dead subscription. If PING_CACHE_TTL_MS grows in the SDK, bump this interval in
  // lockstep (see helpers.ts: WATCHDOG_SELF_PING_INTERVAL_MS).
  const selfPingTimer = setInterval(async () => {
    if (stopped) {
      return;
    }
    if (detectAndHandleSleep()) {
      return;
    }
    if (selfPingBusy) {
      return;
    }
    selfPingBusy = true;
    try {
      const result = await client.ping.pingAgent(identity.publicKey, selfPingTimeoutMs);
      if (stopped || result.online) {
        return;
      }
      log('[watchdog] self-ping failed, resetting pool and re-subscribing');
      logger?.info({ event: 'pool_reset', reason: 'self_ping_failed' }, 'pool reset');
      resetPoolAndResubscribe();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[watchdog] self-ping/reset error: ${errorMessage}`);
      logger?.warn(
        { event: 'self_ping_error', error: errorMessage },
        'watchdog self-ping/reset error',
      );
    } finally {
      selfPingBusy = false;
    }
  }, selfPingIntervalMs);

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(probeTimer);
      clearInterval(selfPingTimer);
      pingSub.close();
    },
  };
}
