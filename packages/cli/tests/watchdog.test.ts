import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrTransport } from '../src/transport/nostr.js';
import { startWatchdog } from '../src/watchdog.js';

interface MockPool {
  probe: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

interface MockPing {
  subscribeToPings: ReturnType<typeof vi.fn>;
  pingAgent: ReturnType<typeof vi.fn>;
}

interface MockTransport {
  stop: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
}

let calls: string[];
let pingSubCloses: ReturnType<typeof vi.fn>[];
let mockPool: MockPool;
let mockPing: MockPing;
let mockTransport: MockTransport;
let log: ReturnType<typeof vi.fn>;

const PROBE_INTERVAL = 100;
const SELF_PING_INTERVAL = 250;

function createClient(): ElisymClient {
  return {
    pool: mockPool,
    ping: mockPing,
  } as unknown as ElisymClient;
}

function createIdentity(): ElisymIdentity {
  return {
    publicKey: 'agent-pubkey',
    secretKey: new Uint8Array(32),
  } as unknown as ElisymIdentity;
}

function build(): ReturnType<typeof startWatchdog> {
  return startWatchdog({
    client: createClient(),
    identity: createIdentity(),
    transport: mockTransport as unknown as NostrTransport,
    onPing: () => {},
    log,
    probeIntervalMs: PROBE_INTERVAL,
    probeTimeoutMs: 10,
    selfPingIntervalMs: SELF_PING_INTERVAL,
    selfPingTimeoutMs: 10,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  pingSubCloses = [];

  mockPool = {
    probe: vi.fn(() => {
      calls.push('probe');
      return Promise.resolve(true);
    }),
    reset: vi.fn(() => {
      calls.push('pool.reset');
    }),
  };

  mockPing = {
    subscribeToPings: vi.fn(() => {
      calls.push('subscribeToPings');
      const close = vi.fn(() => {
        calls.push('pingSub.close');
      });
      pingSubCloses.push(close);
      return { close } as SubCloser;
    }),
    pingAgent: vi.fn(() => {
      calls.push('pingAgent');
      return Promise.resolve({ online: true, identity: null });
    }),
  };

  mockTransport = {
    stop: vi.fn(() => {
      calls.push('transport.stop');
    }),
    restart: vi.fn(() => {
      calls.push('transport.restart');
    }),
  };

  log = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startWatchdog', () => {
  it('creates initial pingSub on start', () => {
    const watchdog = build();
    expect(mockPing.subscribeToPings).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('does nothing when probe succeeds', async () => {
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(mockPool.probe).toHaveBeenCalledTimes(1);
    expect(mockPool.reset).not.toHaveBeenCalled();
    expect(mockTransport.restart).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('resets pool and re-subscribes when probe fails', async () => {
    mockPool.probe.mockImplementation(() => {
      calls.push('probe');
      return Promise.resolve(false);
    });
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);

    const resetSlice = calls.slice(calls.indexOf('probe') + 1);
    expect(resetSlice).toEqual([
      'transport.stop',
      'pool.reset',
      'subscribeToPings',
      'transport.restart',
    ]);
    expect(log).toHaveBeenCalledWith(
      '[watchdog] relay probe failed, resetting pool and re-subscribing',
    );
    watchdog.stop();
  });

  it('does nothing when self-ping returns online', async () => {
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL);
    expect(mockPing.pingAgent).toHaveBeenCalled();
    expect(mockPool.reset).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('resets pool and re-subscribes when self-ping fails', async () => {
    mockPool.probe.mockImplementation(() => Promise.resolve(true));
    mockPing.pingAgent.mockImplementation(() => {
      calls.push('pingAgent');
      return Promise.resolve({ online: false, identity: null });
    });
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL);

    const resetSlice = calls.slice(calls.indexOf('pingAgent') + 1);
    expect(resetSlice).toEqual([
      'transport.stop',
      'pool.reset',
      'subscribeToPings',
      'transport.restart',
    ]);
    expect(log).toHaveBeenCalledWith(
      '[watchdog] self-ping failed, resetting pool and re-subscribing',
    );
    watchdog.stop();
  });

  it('stops both timers and closes pingSub on stop()', async () => {
    mockPool.probe.mockImplementation(() => Promise.resolve(false));
    const watchdog = build();
    watchdog.stop();

    expect(pingSubCloses[0]).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 3);
    expect(mockPool.probe).not.toHaveBeenCalled();
    expect(mockPool.reset).not.toHaveBeenCalled();
  });

  it('bails out if stopped while probe is in flight', async () => {
    let resolveProbe: (v: boolean) => void = () => {};
    mockPool.probe.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(mockPool.probe).toHaveBeenCalledTimes(1);

    watchdog.stop();
    resolveProbe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPool.reset).not.toHaveBeenCalled();
    expect(mockTransport.restart).not.toHaveBeenCalled();
  });

  it('logs and keeps running after a probe error', async () => {
    mockPool.probe
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve(true));
    const watchdog = build();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(log).toHaveBeenCalledWith('[watchdog] probe/reset error: boom');

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(mockPool.probe).toHaveBeenCalledTimes(2);
    watchdog.stop();
  });

  it('is idempotent - stop() twice does not double-close', () => {
    const watchdog = build();
    watchdog.stop();
    watchdog.stop();
    expect(pingSubCloses[0]).toHaveBeenCalledTimes(1);
  });
});

describe('startWatchdog sleep detection', () => {
  function buildWithClock(getMockNow: () => number): ReturnType<typeof startWatchdog> {
    return startWatchdog({
      client: createClient(),
      identity: createIdentity(),
      transport: mockTransport as unknown as NostrTransport,
      onPing: () => {},
      log,
      probeIntervalMs: PROBE_INTERVAL,
      probeTimeoutMs: 10,
      selfPingIntervalMs: SELF_PING_INTERVAL,
      selfPingTimeoutMs: 10,
      now: getMockNow,
    });
  }

  it('forces pool reset on a tick that fires after a long host suspension', async () => {
    // Simulates the macOS-sleep-on-mac-mini case: the JS event loop is paused
    // for hours, both setInterval callbacks freeze, then exactly one of them
    // fires once on resume with `Date.now()` jumped forward by the sleep
    // duration. The watchdog must catch the gap and reset before the dead
    // long-lived ping subscription silently swallows the next external ping.
    let mockNow = 0;
    const watchdog = buildWithClock(() => mockNow);

    // First normal probe tick: clock advanced by exactly one interval, no sleep.
    mockNow = PROBE_INTERVAL;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(mockPool.probe).toHaveBeenCalledTimes(1);
    expect(mockPool.reset).not.toHaveBeenCalled();

    // Mac slept for an hour. Timer scheduler then fires the next tick once.
    const sleepGapMs = 60 * 60 * 1000;
    mockNow += sleepGapMs;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);

    expect(mockPool.reset).toHaveBeenCalledTimes(1);
    expect(mockTransport.stop).toHaveBeenCalled();
    expect(mockTransport.restart).toHaveBeenCalled();
    // Initial subscribeToPings (in startWatchdog) + one more after the reset.
    expect(mockPing.subscribeToPings).toHaveBeenCalledTimes(2);
    // The sleep tick must short-circuit the regular probe to avoid racing
    // against still-half-dead WebSocket state.
    expect(mockPool.probe).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('host suspend / sleep detected'));

    watchdog.stop();
  });

  it('does not trigger a sleep reset under normal interval cadence', async () => {
    let mockNow = 0;
    const watchdog = buildWithClock(() => mockNow);

    // Five back-to-back probe ticks. Each one advances the wall clock by
    // exactly PROBE_INTERVAL, so the gap stays under threshold.
    for (let tick = 1; tick <= 5; tick += 1) {
      mockNow = tick * PROBE_INTERVAL;
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    }

    expect(mockPool.probe).toHaveBeenCalledTimes(5);
    expect(mockPool.reset).not.toHaveBeenCalled();
    expect(mockTransport.stop).not.toHaveBeenCalled();

    watchdog.stop();
  });

  it('lets self-ping fire while a probe is still in flight (separate busy flags)', async () => {
    // Regression guard for the previous shared `busy` flag, which would
    // suppress every self-ping for as long as a probe was pending - exactly
    // the scenario where catching a dead long-lived subscription matters most.
    let resolveProbe: (v: boolean) => void = () => {};
    mockPool.probe.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const watchdog = build();
    // First probe tick: stays pending.
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL);
    expect(mockPool.probe).toHaveBeenCalledTimes(1);
    expect(mockPing.pingAgent).not.toHaveBeenCalled();

    // Advance to the self-ping interval. Probe is still pending; self-ping
    // must still run.
    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL - PROBE_INTERVAL);
    expect(mockPing.pingAgent).toHaveBeenCalledTimes(1);

    resolveProbe(true);
    await Promise.resolve();
    await Promise.resolve();
    watchdog.stop();
  });
});
