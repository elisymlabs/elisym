import { vi } from 'vitest';
import type { IncomingJob, NostrTransport } from '../../src/transport/nostr.js';

export interface FakeTransport {
  transport: NostrTransport;
  triggerJob(job: IncomingJob): void;
  sendFeedback: ReturnType<typeof vi.fn>;
  deliverResult: ReturnType<typeof vi.fn>;
}

/**
 * Minimal transport double for runtime integration tests. Exposes an
 * imperative `triggerJob` helper that forwards synthetic jobs to the
 * runtime's registered callback, plus spies on `sendFeedback` and
 * `deliverResult` so tests can assert the exact sequence of outbound
 * messages a recovery sweep produces.
 */
export function makeFakeTransport(): FakeTransport {
  let onJobCb: ((job: IncomingJob) => void) | null = null;
  const sendFeedback = vi.fn().mockResolvedValue(undefined);
  const deliverResult = vi.fn().mockResolvedValue('result-event-id');
  const transport = {
    start: vi.fn((cb: (job: IncomingJob) => void) => {
      onJobCb = cb;
    }),
    stop: vi.fn(),
    restart: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    sendFeedback,
    deliverResult,
  } as unknown as NostrTransport;
  return {
    transport,
    triggerJob(job: IncomingJob) {
      onJobCb?.(job);
    },
    sendFeedback,
    deliverResult,
  };
}
