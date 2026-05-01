import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmHealthMonitor,
  startLlmRecovery,
  type LlmKeyVerification,
  type LlmKeyVerifyFn,
} from '../src/llm-health';

function ok(): LlmKeyVerification {
  return { ok: true };
}
function billing(): LlmKeyVerification {
  return { ok: false, reason: 'billing', status: 402, body: 'credit balance too low' };
}

describe('startLlmRecovery (lazy mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips probes while every pair is healthy', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    const handle = startLlmRecovery({ monitor, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // No probes: state was healthy on every tick, no work to do.
    expect(verify).toHaveBeenCalledTimes(0);
    handle.stop();
  });

  it('probes once when an unhealthy pair is registered, then recovers', async () => {
    let result: LlmKeyVerification = billing();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => result);
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', billing());

    const handle = startLlmRecovery({ monitor, intervalMs: 1000 });

    // First tick: pair is unhealthy -> probe, still billing.
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(1);

    // Recovery: provider returns ok on next probe.
    result = ok();
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(2);

    // Healthy now: subsequent ticks must not probe.
    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('logs unhealthy -> healthy recovery', async () => {
    let result: LlmKeyVerification = billing();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => result);
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', billing());

    const logs: string[] = [];
    const handle = startLlmRecovery({
      monitor,
      intervalMs: 1000,
      log: (msg) => logs.push(msg),
    });

    result = ok();
    await vi.advanceTimersByTimeAsync(1000);

    const recovery = logs.find((message) => message.includes('recovered'));
    expect(recovery).toBeDefined();
    expect(recovery).toContain('anthropic');

    handle.stop();
  });

  it('does not log on steady healthy state', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    const logs: string[] = [];
    const handle = startLlmRecovery({
      monitor,
      intervalMs: 1000,
      log: (msg) => logs.push(msg),
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(logs).toHaveLength(0);
    handle.stop();
  });

  it('stop prevents further ticks', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => billing());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', billing());

    const handle = startLlmRecovery({ monitor, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(1);

    handle.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('LlmHealthMonitor.markUnhealthyFromJob', () => {
  it('flips a healthy pair to billing-unhealthy without a fresh probe', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    monitor.markUnhealthyFromJob('anthropic', 'haiku', 'billing', 'HTTP 402 from real job');

    const snapshot = monitor.snapshot();
    expect(snapshot[0]?.status).toBe('billing');
    expect(snapshot[0]?.lastReason).toContain('HTTP 402 from real job');
    // No verify call: marking is purely state-mutating.
    expect(verify).toHaveBeenCalledTimes(0);

    // Subsequent assertReady must throw (cached unhealthy).
    await expect(monitor.assertReady('anthropic', 'haiku')).rejects.toThrow(/billing/);
  });

  it('classifies invalid and unavailable reasons distinctly', () => {
    const monitor = new LlmHealthMonitor();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    monitor.register({ provider: 'p', model: 'm', verifyFn: verify });

    monitor.markUnhealthyFromJob('p', 'm', 'invalid', 'auth failed');
    expect(monitor.snapshot()[0]?.status).toBe('invalid');

    monitor.seed('p', 'm', ok());
    monitor.markUnhealthyFromJob('p', 'm', 'unavailable', 'connection reset');
    expect(monitor.snapshot()[0]?.status).toBe('unavailable');
  });

  it('is a no-op for unregistered pairs', () => {
    const monitor = new LlmHealthMonitor();
    expect(() => monitor.markUnhealthyFromJob('foo', 'bar', 'billing')).not.toThrow();
    expect(monitor.snapshot()).toHaveLength(0);
  });

  it('integrates with lazy recovery: reactive mark + probe success returns to healthy', async () => {
    vi.useFakeTimers();
    let result: LlmKeyVerification = ok();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => result);
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    const handle = startLlmRecovery({ monitor, intervalMs: 1000 });

    // While healthy, no probes.
    await vi.advanceTimersByTimeAsync(2000);
    expect(verify).toHaveBeenCalledTimes(0);

    // Real job surfaces 402 -> reactive mark.
    monitor.markUnhealthyFromJob('anthropic', 'haiku', 'billing', 'HTTP 402');
    expect(monitor.snapshot()[0]?.status).toBe('billing');

    // Recovery loop sees unhealthy on next tick, probes, key still bad.
    result = { ok: false, reason: 'billing', status: 402, body: 'still empty' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()[0]?.status).toBe('billing');

    // Operator tops up; next probe succeeds and the loop falls quiet.
    result = ok();
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(monitor.snapshot()[0]?.status).toBe('healthy');

    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).toHaveBeenCalledTimes(2);

    handle.stop();
    vi.useRealTimers();
  });
});
