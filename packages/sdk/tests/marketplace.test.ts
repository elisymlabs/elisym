import { finalizeEvent, type Event, type Filter } from 'nostr-tools';
import { describe, it, expect, vi } from 'vitest';
import {
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST_BASE,
  LIMITS,
} from '../src/constants';
import { nip44Encrypt, nip44Decrypt } from '../src/primitives/crypto';
import { ElisymIdentity } from '../src/primitives/identity';
import { MarketplaceService } from '../src/services/marketplace';
import type { NostrPool } from '../src/transport/pool';
import type { SubCloser } from '../src/types';

// Minimal mock for NostrPool
function createMockPool(): NostrPool & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
    publish: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    publishAll: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    subscribe: vi.fn((): SubCloser => ({ close: vi.fn() })),
    subscribeAndWait: vi.fn(async (): Promise<SubCloser> => ({ close: vi.fn() })),
    probe: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as any;
}

/** Mock pool that captures subscription callbacks so tests can fire events. */
function createCallbackMockPool() {
  const published: Event[] = [];
  const subs: {
    filter: Filter;
    onEvent: (ev: Event) => void;
    closeFn: ReturnType<typeof vi.fn>;
  }[] = [];
  return {
    published,
    subs,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
    publish: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    publishAll: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    subscribe: vi.fn((filter: Filter, onEvent: (ev: Event) => void) => {
      const closeFn = vi.fn();
      subs.push({ filter, onEvent, closeFn });
      return { close: closeFn };
    }),
    subscribeAndWait: vi.fn(async (): Promise<SubCloser> => ({ close: vi.fn() })),
    probe: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as any;
}

describe('MarketplaceService.submitJobRequest', () => {
  it('creates encrypted event for targeted job', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();

    await svc.submitJobRequest(customer, {
      input: 'test prompt',
      capability: 'text-gen',
      providerPubkey: provider.publicKey,
    });

    expect(pool.published.length).toBe(1);
    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_REQUEST);
    expect(ev.tags.find((t) => t[0] === 'p')?.[1]).toBe(provider.publicKey);
    expect(ev.tags.find((t) => t[0] === 'encrypted')?.[1]).toBe('nip44');
    expect(ev.tags.find((t) => t[0] === 'i')?.[1]).toBe('encrypted');

    // Content should be encrypted (not plaintext)
    expect(ev.content).not.toBe('test prompt');

    // Should be decryptable by provider
    const decrypted = nip44Decrypt(ev.content, provider.secretKey, customer.publicKey);
    expect(decrypted).toBe('test prompt');
  });

  it('creates broadcast event without encryption', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();

    await svc.submitJobRequest(customer, {
      input: 'broadcast prompt',
      capability: 'text-gen',
    });

    expect(pool.published.length).toBe(1);
    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_REQUEST);
    expect(ev.tags.find((t) => t[0] === 'p')).toBeUndefined();
    expect(ev.tags.find((t) => t[0] === 'encrypted')).toBeUndefined();
    // i tag should contain 'text' marker (input is in content only to avoid duplication)
    expect(ev.tags.find((t) => t[0] === 'i')?.[1]).toBe('text');
    // Content should be plaintext
    expect(ev.content).toBe('broadcast prompt');
  });

  it('rejects empty input', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();

    await expect(
      svc.submitJobRequest(customer, { input: '', capability: 'text-gen' }),
    ).rejects.toThrow('Job input must not be empty');
  });
});

describe('MarketplaceService.submitJobResult', () => {
  it('encrypts result for encrypted request', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    // Simulate an encrypted request event
    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', provider.publicKey],
          ['encrypted', 'nip44'],
          ['t', 'text-gen'],
        ],
        content: nip44Encrypt('request content', customer.secretKey, provider.publicKey),
      },
      customer.secretKey,
    );

    await svc.submitJobResult(provider, requestEvent, 'result content');

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_RESULT);
    expect(ev.tags.find((t) => t[0] === 'encrypted')?.[1]).toBe('nip44');
    expect(ev.content).not.toBe('result content');

    // Customer should be able to decrypt
    const decrypted = nip44Decrypt(ev.content, customer.secretKey, provider.publicKey);
    expect(decrypted).toBe('result content');
  });

  it('does not encrypt result for broadcast request', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    // Simulate a broadcast (non-encrypted) request event
    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'broadcast request',
      },
      customer.secretKey,
    );

    await svc.submitJobResult(provider, requestEvent, 'result content');

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_RESULT);
    expect(ev.tags.find((t) => t[0] === 'encrypted')).toBeUndefined();
    expect(ev.content).toBe('result content');
  });

  it('rejects invalid request kind', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    // Event with kind outside NIP-90 range
    const requestEvent = finalizeEvent(
      {
        kind: 1, // regular note, not a job request
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'not a job',
      },
      customer.secretKey,
    );

    await expect(svc.submitJobResult(provider, requestEvent, 'result')).rejects.toThrow(
      'Invalid request event kind',
    );
  });

  it('rejects kind above 5999', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: 6100, // result kind, not request
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'wrong kind',
      },
      customer.secretKey,
    );

    await expect(svc.submitJobResult(provider, requestEvent, 'result')).rejects.toThrow(
      'Invalid request event kind',
    );
  });
});

describe('MarketplaceService.queryJobResults', () => {
  it('keeps newest result per request', async () => {
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const reqId = 'request123';

    // Simulate two results for the same request, older first (signed events)
    const olderResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: 1000,
        tags: [['e', reqId]],
        content: 'old result',
      },
      provider.secretKey,
    );
    const newerResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: 2000,
        tags: [['e', reqId]],
        content: 'new result',
      },
      provider.secretKey,
    );

    const pool = createMockPool();
    // Return results in oldest-first order
    (pool.queryBatchedByTag as any).mockResolvedValue([olderResult, newerResult]);

    const svc = new MarketplaceService(pool as any);
    const results = await svc.queryJobResults(customer, [reqId]);

    expect(results.get(reqId)?.content).toBe('new result');
  });

  it('keeps newest even if newer arrives first in array', async () => {
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const reqId = 'request456';

    const newerResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: 2000,
        tags: [['e', reqId]],
        content: 'new result',
      },
      provider.secretKey,
    );
    const olderResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: 1000,
        tags: [['e', reqId]],
        content: 'old result',
      },
      provider.secretKey,
    );

    const pool = createMockPool();
    // Return results in newest-first order
    (pool.queryBatchedByTag as any).mockResolvedValue([newerResult, olderResult]);

    const svc = new MarketplaceService(pool as any);
    const results = await svc.queryJobResults(customer, [reqId]);

    expect(results.get(reqId)?.content).toBe('new result');
  });
});

// --- subscribeToJobUpdates ---

describe('MarketplaceService.subscribeToJobUpdates', () => {
  it('creates 3 subscriptions (feedback, result by #e, result by #p+#e)', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      customerPublicKey: customer.publicKey,
      callbacks: {},
    });

    expect(pool.subs.length).toBe(3);
    // Feedback subscription
    expect(pool.subs[0]!.filter.kinds).toContain(KIND_JOB_FEEDBACK);
    // Result subscriptions
    expect(pool.subs[1]!.filter.kinds).toContain(KIND_JOB_RESULT);
    expect(pool.subs[2]!.filter.kinds).toContain(KIND_JOB_RESULT);
  });

  it('calls onFeedback for feedback events', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const onFeedback = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      providerPubkey: provider.publicKey,
      customerPublicKey: customer.publicKey,
      callbacks: { onFeedback },
    });

    const feedbackEvent = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', 'job1'],
          ['p', customer.publicKey],
          ['status', 'payment-required'],
          ['amount', '100000', '{"recipient":"addr"}', 'solana'],
        ],
        content: '',
      },
      provider.secretKey,
    );

    // Fire through feedback subscription handler
    pool.subs[0]!.onEvent(feedbackEvent);
    expect(onFeedback).toHaveBeenCalledWith(
      'payment-required',
      100000,
      '{"recipient":"addr"}',
      provider.publicKey,
    );
  });

  it('calls onResult for plaintext result events', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const onResult = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      providerPubkey: provider.publicKey,
      customerPublicKey: customer.publicKey,
      callbacks: { onResult },
    });

    const resultEvent = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', 'job1'],
          ['p', customer.publicKey],
        ],
        content: 'Here is your result',
      },
      provider.secretKey,
    );

    // Fire through result subscription handler (index 1)
    pool.subs[1]!.onEvent(resultEvent);
    expect(onResult).toHaveBeenCalledWith('Here is your result', resultEvent.id);
  });

  it('decrypts encrypted result events', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const onResult = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      providerPubkey: provider.publicKey,
      customerPublicKey: customer.publicKey,
      customerSecretKey: customer.secretKey,
      callbacks: { onResult },
    });

    const encrypted = nip44Encrypt('secret result', provider.secretKey, customer.publicKey);
    const resultEvent = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', 'job1'],
          ['p', customer.publicKey],
          ['encrypted', 'nip44'],
        ],
        content: encrypted,
      },
      provider.secretKey,
    );

    pool.subs[1]!.onEvent(resultEvent);
    expect(onResult).toHaveBeenCalledWith('secret result', resultEvent.id);
  });

  it('skips undecryptable results (DoS protection)', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const rogue = ElisymIdentity.generate();
    const onResult = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      customerPublicKey: customer.publicKey,
      customerSecretKey: customer.secretKey,
      callbacks: { onResult },
    });

    // Rogue agent sends encrypted content that customer can't decrypt
    const rogueResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', 'job1'],
          ['p', customer.publicKey],
          ['encrypted', 'nip44'],
        ],
        content: 'not-valid-nip44-ciphertext',
      },
      rogue.secretKey,
    );

    pool.subs[1]!.onEvent(rogueResult);
    // Should be silently skipped - no crash, no callback
    expect(onResult).not.toHaveBeenCalled();
  });

  it('calls onError on timeout', async () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const onError = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      customerPublicKey: customer.publicKey,
      callbacks: { onError },
      timeoutMs: 50,
    });

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 100));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Timed out'));
  });

  it('cleanup function closes all subscriptions', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();

    const cleanup = svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      customerPublicKey: customer.publicKey,
      callbacks: {},
    });

    cleanup();
    for (const sub of pool.subs) {
      expect(sub.closeFn).toHaveBeenCalled();
    }
  });

  it('rejects empty kindOffsets', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();

    expect(() =>
      svc.subscribeToJobUpdates({
        jobEventId: 'job1',
        customerPublicKey: customer.publicKey,
        callbacks: {},
        kindOffsets: [],
      }),
    ).toThrow('kindOffsets must not be empty');
  });

  it('ignores feedback from wrong provider', () => {
    const pool = createCallbackMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const rogue = ElisymIdentity.generate();
    const onFeedback = vi.fn();

    svc.subscribeToJobUpdates({
      jobEventId: 'job1',
      providerPubkey: provider.publicKey,
      customerPublicKey: customer.publicKey,
      callbacks: { onFeedback },
    });

    const rogueEvent = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', 'job1'],
          ['status', 'payment-required'],
        ],
        content: '',
      },
      rogue.secretKey,
    );

    pool.subs[0]!.onEvent(rogueEvent);
    expect(onFeedback).not.toHaveBeenCalled();
  });
});

// --- submitJobResult ---

describe('MarketplaceService.submitJobResult', () => {
  it('rejects empty content', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    await expect(svc.submitJobResult(provider, requestEvent, '')).rejects.toThrow(
      'Job result content must not be empty',
    );
    expect(pool.published.length).toBe(0);
  });

  it('accepts static capability result (non-empty content)', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'static-data']],
        content: 'static-data',
      },
      customer.secretKey,
    );

    const id = await svc.submitJobResult(provider, requestEvent, 'pre-defined static result');
    expect(id).toBeTruthy();
    expect(pool.published.length).toBe(1);
    expect(pool.published[0]!.content).toBe('pre-defined static result');
  });
});

// --- submitJobResultWithRetry ---

describe('MarketplaceService.submitJobResultWithRetry', () => {
  it('succeeds on first attempt', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    const id = await svc.submitJobResultWithRetry(
      provider,
      requestEvent,
      'result',
      undefined,
      3,
      10,
    );
    expect(id).toBeTruthy();
    expect(pool.published.length).toBe(1);
  });

  it('retries on publish failure and succeeds', async () => {
    const pool = createMockPool();
    let callCount = 0;
    (pool.publishAll as any).mockImplementation(async (event: Event) => {
      callCount++;
      if (callCount < 2) throw new Error('relay down');
      pool.published.push(event);
    });

    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    const id = await svc.submitJobResultWithRetry(
      provider,
      requestEvent,
      'result',
      undefined,
      3,
      10,
    );
    expect(id).toBeTruthy();
    expect(callCount).toBe(2);
  });

  it('throws after all attempts exhausted', async () => {
    const pool = createMockPool();
    (pool.publishAll as any).mockRejectedValue(new Error('relay down'));

    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    await expect(
      svc.submitJobResultWithRetry(provider, requestEvent, 'result', undefined, 3, 10),
    ).rejects.toThrow('relay down');
  });
});

// --- submitPaymentRequiredFeedback ---

describe('MarketplaceService.submitPaymentRequiredFeedback', () => {
  it('publishes correct feedback event', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    await svc.submitPaymentRequiredFeedback(
      provider,
      requestEvent,
      100_000,
      '{"recipient":"addr"}',
    );
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_FEEDBACK);
    expect(ev.tags.find((t) => t[0] === 'status')?.[1]).toBe('payment-required');
    expect(ev.tags.find((t) => t[0] === 'amount')?.[1]).toBe('100000');
    expect(ev.tags.find((t) => t[0] === 'amount')?.[2]).toBe('{"recipient":"addr"}');
  });

  it('rejects zero amount', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      { kind: KIND_JOB_REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' },
      customer.secretKey,
    );

    await expect(
      svc.submitPaymentRequiredFeedback(provider, requestEvent, 0, '{}'),
    ).rejects.toThrow('Invalid payment amount');
  });

  it('rejects invalid JSON', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      { kind: KIND_JOB_REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' },
      customer.secretKey,
    );

    await expect(
      svc.submitPaymentRequiredFeedback(provider, requestEvent, 100, 'not json'),
    ).rejects.toThrow('valid JSON');
  });
});

// --- submitPaymentConfirmation ---

describe('MarketplaceService.submitPaymentConfirmation', () => {
  it('publishes correct feedback event', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();

    await svc.submitPaymentConfirmation(customer, 'job1', provider.publicKey, 'tx123');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_FEEDBACK);
    expect(ev.tags.find((t) => t[0] === 'status')?.[1]).toBe('payment-completed');
    expect(ev.tags.find((t) => t[0] === 'tx')?.[1]).toBe('tx123');
    expect(ev.tags.find((t) => t[0] === 'e')?.[1]).toBe('job1');
  });
});

// --- submitFeedback ---

describe('MarketplaceService.submitFeedback', () => {
  it('publishes positive rating feedback', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();

    await svc.submitFeedback(customer, 'job1', provider.publicKey, true, 'text-gen');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_FEEDBACK);
    expect(ev.tags.find((t) => t[0] === 'rating')?.[1]).toBe('1');
    expect(ev.tags.find((t) => t[0] === 'status')?.[1]).toBe('success');
    expect(ev.tags.find((t) => t[0] === 't' && t[1] === 'text-gen')).toBeTruthy();
  });

  it('publishes negative rating feedback', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();

    await svc.submitFeedback(customer, 'job1', provider.publicKey, false);
    const ev = pool.published[0]!;
    expect(ev.tags.find((t) => t[0] === 'rating')?.[1]).toBe('0');
    expect(ev.content).toBe('Poor result');
  });
});

// --- submitProcessingFeedback ---

describe('MarketplaceService.submitProcessingFeedback', () => {
  it('publishes processing feedback with correct tags', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    await svc.submitProcessingFeedback(provider, requestEvent);
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_FEEDBACK);
    expect(ev.tags.find((t) => t[0] === 'e')?.[1]).toBe(requestEvent.id);
    expect(ev.tags.find((t) => t[0] === 'p')?.[1]).toBe(customer.publicKey);
    expect(ev.tags.find((t) => t[0] === 'status')?.[1]).toBe('processing');
    expect(ev.tags.find((t) => t[0] === 't')?.[1]).toBe('elisym');
    expect(ev.content).toBe('');
  });
});

// --- submitErrorFeedback ---

describe('MarketplaceService.submitErrorFeedback', () => {
  it('publishes error feedback with message', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      {
        kind: KIND_JOB_REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'text-gen']],
        content: 'test',
      },
      customer.secretKey,
    );

    await svc.submitErrorFeedback(provider, requestEvent, 'Something went wrong');
    expect(pool.published.length).toBe(1);

    const ev = pool.published[0]!;
    expect(ev.kind).toBe(KIND_JOB_FEEDBACK);
    expect(ev.tags.find((t) => t[0] === 'e')?.[1]).toBe(requestEvent.id);
    expect(ev.tags.find((t) => t[0] === 'p')?.[1]).toBe(customer.publicKey);
    expect(ev.tags.find((t) => t[0] === 'status')?.[1]).toBe('error');
    expect(ev.tags.find((t) => t[0] === 't')?.[1]).toBe('elisym');
    expect(ev.content).toBe('Something went wrong');
  });

  it('rejects empty message', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      { kind: KIND_JOB_REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' },
      customer.secretKey,
    );

    await expect(svc.submitErrorFeedback(provider, requestEvent, '')).rejects.toThrow(
      'Error message must not be empty',
    );
  });

  it('rejects too long message', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();

    const requestEvent = finalizeEvent(
      { kind: KIND_JOB_REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' },
      customer.secretKey,
    );

    const longMessage = 'x'.repeat(LIMITS.MAX_INPUT_LENGTH + 1);
    await expect(svc.submitErrorFeedback(provider, requestEvent, longMessage)).rejects.toThrow(
      'Error message too long',
    );
  });
});
