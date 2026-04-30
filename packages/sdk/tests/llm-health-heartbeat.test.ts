import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmHealthMonitor,
  type LlmKeyVerification,
  type LlmKeyVerifyFn,
  startLlmHeartbeat,
} from '../src/llm-health';

function ok(): LlmKeyVerification {
  return { ok: true };
}
function billing(): LlmKeyVerification {
  return { ok: false, reason: 'billing', status: 402, body: 'credit balance too low' };
}

describe('startLlmHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs refreshAll on the configured interval', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    const handle = startLlmHeartbeat({ monitor, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(verify).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  it('logs healthy -> unhealthy transition', async () => {
    let result: LlmKeyVerification = ok();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => result);
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', ok());

    const logs: string[] = [];
    const handle = startLlmHeartbeat({
      monitor,
      intervalMs: 1000,
      log: (msg) => logs.push(msg),
    });

    result = billing();
    await vi.advanceTimersByTimeAsync(1000);

    const transition = logs.find((l) => l.includes('became unhealthy'));
    expect(transition).toBeDefined();
    expect(transition).toContain('anthropic');
    expect(transition).toContain('billing');

    handle.stop();
  });

  it('logs unhealthy -> healthy recovery', async () => {
    let result: LlmKeyVerification = billing();
    const verify = vi.fn<LlmKeyVerifyFn>(async () => result);
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });
    monitor.seed('anthropic', 'haiku', billing());

    const logs: string[] = [];
    const handle = startLlmHeartbeat({
      monitor,
      intervalMs: 1000,
      log: (msg) => logs.push(msg),
    });

    result = ok();
    await vi.advanceTimersByTimeAsync(1000);

    const recovery = logs.find((l) => l.includes('recovered'));
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
    const handle = startLlmHeartbeat({
      monitor,
      intervalMs: 1000,
      log: (msg) => logs.push(msg),
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(logs).toHaveLength(0);
    handle.stop();
  });

  it('stop prevents further ticks', async () => {
    const verify = vi.fn<LlmKeyVerifyFn>(async () => ok());
    const monitor = new LlmHealthMonitor();
    monitor.register({ provider: 'anthropic', model: 'haiku', verifyFn: verify });

    const handle = startLlmHeartbeat({ monitor, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(1);

    handle.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
