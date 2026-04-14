/**
 * Watchdog - periodically verifies relay connectivity and subscription liveness,
 * rebuilds the Nostr pool and re-subscribes on failure.
 *
 * Works around a nostr-tools bug where a single WS error sets `skipReconnection=true`
 * and silently kills long-lived subscriptions for the rest of the process
 * (see `NostrPool.reset` in @elisym/sdk).
 *
 * Two independent health checks:
 * - `probe`: cheap `querySync` round-trip against relays.
 * - `self-ping`: full subscribeToPings -> sendPong round-trip via the agent's
 *   own identity, catches the case where probe passes (fresh query works) but
 *   the live subscription is already dead.
 */
import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import {
  WATCHDOG_PROBE_INTERVAL_MS,
  WATCHDOG_PROBE_TIMEOUT_MS,
  WATCHDOG_SELF_PING_INTERVAL_MS,
  WATCHDOG_SELF_PING_TIMEOUT_MS,
} from './helpers.js';
import type { NostrTransport } from './transport/nostr.js';

export interface WatchdogDeps {
  client: ElisymClient;
  identity: ElisymIdentity;
  transport: NostrTransport;
  onPing: (senderPubkey: string, nonce: string) => void;
  log: (message: string) => void;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  selfPingIntervalMs?: number;
  selfPingTimeoutMs?: number;
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
    probeIntervalMs = WATCHDOG_PROBE_INTERVAL_MS,
    probeTimeoutMs = WATCHDOG_PROBE_TIMEOUT_MS,
    selfPingIntervalMs = WATCHDOG_SELF_PING_INTERVAL_MS,
    selfPingTimeoutMs = WATCHDOG_SELF_PING_TIMEOUT_MS,
  } = deps;

  let pingSub: SubCloser = client.ping.subscribeToPings(identity, onPing);
  let stopped = false;
  let busy = false;

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

  const probeTimer = setInterval(async () => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    try {
      const ok = await client.pool.probe(probeTimeoutMs);
      if (stopped || ok) {
        return;
      }
      log('[watchdog] relay probe failed, resetting pool and re-subscribing');
      resetPoolAndResubscribe();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[watchdog] probe/reset error: ${errorMessage}`);
    } finally {
      busy = false;
    }
  }, probeIntervalMs);

  // CRITICAL: PingService caches "online" results for PING_CACHE_TTL_MS (30s in SDK).
  // `selfPingIntervalMs` MUST stay greater than that cache TTL, otherwise pingAgent
  // will keep returning cached `online: true` and the watchdog will never detect a
  // dead subscription. If PING_CACHE_TTL_MS grows in the SDK, bump this interval in
  // lockstep (see helpers.ts: WATCHDOG_SELF_PING_INTERVAL_MS).
  const selfPingTimer = setInterval(async () => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    try {
      const result = await client.ping.pingAgent(identity.publicKey, selfPingTimeoutMs);
      if (stopped || result.online) {
        return;
      }
      log('[watchdog] self-ping failed, resetting pool and re-subscribing');
      resetPoolAndResubscribe();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[watchdog] self-ping/reset error: ${errorMessage}`);
    } finally {
      busy = false;
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
