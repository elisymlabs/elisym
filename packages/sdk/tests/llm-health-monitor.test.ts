import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmHealthError,
  LlmHealthMonitor,
  type LlmKeyVerification,
  type LlmKeyVerifyFn,
} from '../src/llm-health';

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function ok(): LlmKeyVerification {
  return { ok: true };
}
function invalid(): LlmKeyVerification {
  return { ok: false, reason: 'invalid', status: 401, body: 'unauthorized' };
}
function billing(): LlmKeyVerification {
  return { ok: false, reason: 'billing', status: 402, body: 'credit balance too low' };
}
function unavailable(error = 'fetch failed'): LlmKeyVerification {
  return { ok: false, reason: 'unavailable', error };
}

describe('LlmHealthMonitor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats unregistered pair as invalid in assertReady', async () => {
    const monitor = new LlmHealthMonitor();
    await expect(monitor.assertReady('anthropic', 'claude-haiku-4-5-20251001')).rejects.toThrow(
      LlmHealthError,
    );
  });

  it('seed avoids the first probe when within TTL', async () => {
    const clock = fakeClock();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor({ now: clock.now });

    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    await monitor.assertReady('anthropic', 'haiku');

    expect(verify).toHaveBeenCalledTimes(0);
  });

  it('re-probes after TTL expiry', async () => {
    const clock = fakeClock();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor({ ttlMs: 60_000, now: clock.now });

    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    clock.advance(61_000);
    await monitor.assertReady('anthropic', 'haiku');

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('throws on invalid', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => invalid());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    await expect(monitor.assertReady('anthropic', 'haiku')).rejects.toMatchObject({
      reason: 'invalid',
      provider: 'anthropic',
      model: 'haiku',
    });
  });

  it('throws on billing', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => billing());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    await expect(monitor.assertReady('anthropic', 'haiku')).rejects.toMatchObject({
      reason: 'billing',
    });
  });

  it('tolerates unavailable up to threshold then throws', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => unavailable());
    const monitor = new LlmHealthMonitor({ unavailableTolerance: 3 });
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    await monitor.assertReady('anthropic', 'haiku'); // failure 1, tolerated
    await monitor.assertReady('anthropic', 'haiku'); // failure 2, tolerated
    await expect(monitor.assertReady('anthropic', 'haiku')).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('successful probe resets unavailable counter', async () => {
    const results = [unavailable(), unavailable(), ok()];
    let i = 0;
    const verify = vi.fn<LlmKeyVerifyFn>(async () => results[i++]!);
    const monitor = new LlmHealthMonitor({ unavailableTolerance: 3 });
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    await monitor.assertReady('anthropic', 'haiku'); // unavailable 1
    await monitor.assertReady('anthropic', 'haiku'); // unavailable 2
    await monitor.assertReady('anthropic', 'haiku'); // ok, counter resets

    const snapshot = monitor.snapshot();
    expect(snapshot[0]?.consecutiveFailures).toBe(0);
    expect(snapshot[0]?.status).toBe('healthy');
  });

  it('caches healthy result within TTL across calls', async () => {
    const clock = fakeClock();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor({ ttlMs: 60_000, now: clock.now });
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    for (let i = 0; i < 50; i++) {
      await monitor.assertReady('anthropic', 'haiku');
    }
    expect(verify).toHaveBeenCalledTimes(0);
  });

  it('dedupes concurrent probes for the same pair', async () => {
    let resolveProbe: ((value: LlmKeyVerification) => void) | undefined;
    const verify = vi.fn<LlmKeyVerifyFn>(
      () =>
        new Promise<LlmKeyVerification>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    const a = monitor.assertReady('anthropic', 'haiku');
    const b = monitor.assertReady('anthropic', 'haiku');
    const c = monitor.assertReady('anthropic', 'haiku');

    // Give microtasks a chance to schedule the awaiting consumers.
    await Promise.resolve();
    expect(verify).toHaveBeenCalledTimes(1);

    resolveProbe!(ok());
    await Promise.all([a, b, c]);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('markFailureFromJob forces a re-probe on next assertReady', async () => {
    const clock = fakeClock();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor({ ttlMs: 60_000, now: clock.now });
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    await monitor.assertReady('anthropic', 'haiku');
    expect(verify).toHaveBeenCalledTimes(0);

    monitor.markFailureFromJob('anthropic', 'haiku');
    await monitor.assertReady('anthropic', 'haiku');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('refreshAll probes every registered pair concurrently', async () => {
    const verifyA = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const verifyB = vi.fn<LlmKeyVerifyFn>(async () => billing());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verifyA });
    monitor.register({ provider: 'openai', model: 'gpt-4o-mini', verifyFn: verifyB });

    const snapshot = await monitor.refreshAll();

    expect(verifyA).toHaveBeenCalledTimes(1);
    expect(verifyB).toHaveBeenCalledTimes(1);
    const states = new Map(snapshot.map((s) => [`${s.provider}/${s.model}`, s.status]));
    expect(states.get('anthropic/haiku')).toBe('healthy');
    expect(states.get('openai/gpt-4o-mini')).toBe('billing');
  });

  it('catches verifyFn throws and records as unavailable', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => {
      throw new Error('ENOTFOUND api.anthropic.com');
    });
    const monitor = new LlmHealthMonitor({ unavailableTolerance: 3 });
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    await monitor.assertReady('anthropic', 'haiku');
    const snap = monitor.snapshot();
    expect(snap[0]?.status).toBe('unavailable');
    expect(snap[0]?.lastReason).toContain('ENOTFOUND');
  });

  it('register replaces verifyFn and resets state for the pair', async () => {
    const v1 = vi.fn<LlmKeyVerifyFn>(async () => invalid());
    const v2 = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: v1 });
    monitor.seed('anthropic', 'haiku', invalid());

    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: v2 });

    await monitor.assertReady('anthropic', 'haiku');
    expect(v1).toHaveBeenCalledTimes(0);
    expect(v2).toHaveBeenCalledTimes(1);
  });
});
