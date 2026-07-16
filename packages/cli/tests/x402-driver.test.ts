import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SOL, USDC_SOLANA_DEVNET, generateSolanaWallet } from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInput, X402SkillJob } from '../src/skill/index.js';
import {
  X402_MAX_PAID_ATTEMPTS,
  X402_MAX_PAYMENT_SIGNATURES,
  X402_SOLANA_DEVNET_CAIP2,
} from '../src/x402/constants.js';
import { X402PermanentError, X402PreflightError, X402TransientError } from '../src/x402/errors.js';
import { X402JobStore } from '../src/x402/store.js';

// ── module mocks ──
// The wrapper/scheme/probe/balance boundaries are mocked so driver logic
// (preflight checks, budget, classification, caching) is tested in
// isolation; the real @x402 interplay is covered by the integration test.
const mocks = vi.hoisted(() => ({
  fetchUsdcBalance: vi.fn(),
  probePaymentRequiredCached: vi.fn(),
  // Simulates wrapFetchWithPayment: unpaid pass first; on 402, retry once
  // with a PAYMENT-SIGNATURE header through the SAME injected fetch (this
  // is the contract the instrumented attempt recording relies on).
  wrapFetchWithPayment: vi.fn(
    (fetchFn: typeof globalThis.fetch) =>
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const unpaid = await fetchFn(input, init);
        if (unpaid.status !== 402) {
          return unpaid;
        }
        const headers = new Headers(init?.headers);
        headers.set('PAYMENT-SIGNATURE', 'test-signature');
        return fetchFn(input, { ...init, headers });
      },
  ),
}));

vi.mock('../src/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/helpers.js')>();
  return { ...original, fetchUsdcBalance: mocks.fetchUsdcBalance };
});

vi.mock('../src/x402/probe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/x402/probe.js')>();
  return { ...original, probePaymentRequiredCached: mocks.probePaymentRequiredCached };
});

vi.mock('@x402/fetch', () => ({
  wrapFetchWithPayment: mocks.wrapFetchWithPayment,
  x402Client: {
    fromConfig: vi.fn(() => ({ registerV1: vi.fn(() => ({})) })),
  },
}));

vi.mock('@x402/svm', () => ({
  ExactSvmScheme: class MockExactSvmScheme {},
}));

import { X402Driver } from '../src/x402/driver.js';

const USDC_MINT = USDC_SOLANA_DEVNET.mint ?? '';

/** Millisecond-scale backoff so inline-retry tests run on real timers. */
const TEST_FREE_RETRY_DELAYS = [5, 10];

function requirementAt(amount: string) {
  return {
    scheme: 'exact',
    network: X402_SOLANA_DEVNET_CAIP2,
    amount,
    asset: USDC_MINT,
    payTo: 'PayToAddress11111111111111111111111111111111',
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function multiProbe(...amounts: string[]) {
  return { x402Version: 2, accepts: amounts.map(requirementAt) };
}

function acceptableProbe(amount: string) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: X402_SOLANA_DEVNET_CAIP2,
        amount,
        asset: USDC_MINT,
        payTo: 'PayToAddress11111111111111111111111111111111',
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

describe('X402Driver', () => {
  let dir: string;
  let wallet: Awaited<ReturnType<typeof generateSolanaWallet>>;
  let driver: X402Driver;
  let job: X402SkillJob;

  const input: SkillInput = {
    data: 'hello upstream',
    inputType: 'text',
    tags: ['market-data'],
    jobId: 'a'.repeat(64),
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-x402-driver-'));
    wallet = await generateSolanaWallet();
    driver = new X402Driver({
      agentDir: dir,
      paymentsAddress: wallet.signer.address,
      solanaSecretKeyBase58: wallet.secretKeyBase58,
      rpcUrl: 'http://127.0.0.1:1/never-used',
      getFeeBps: async () => 250,
      log: () => {},
      freeRetryDelaysMs: TEST_FREE_RETRY_DELAYS,
    });
    job = {
      skillName: 'market-data',
      params: {
        url: 'https://api.example.com/premium-data',
        method: 'POST',
        queryParam: undefined,
        maxUpstreamSubunits: 10_000n,
        maxInputBytes: 100_000,
      },
      priceSubunits: 60_000,
      asset: USDC_SOLANA_DEVNET,
    };
    mocks.fetchUsdcBalance.mockResolvedValue(1_000_000n);
    mocks.probePaymentRequiredCached.mockResolvedValue(acceptableProbe('5000'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe('preflight', () => {
    it('passes the happy path', async () => {
      await expect(driver.preflight(job, input)).resolves.toBeUndefined();
    });

    it('passes trivially when a bought result is already cached (cache-first)', async () => {
      const store = new X402JobStore(dir);
      await store.saveTextResult(input.jobId, 'bought result');
      mocks.probePaymentRequiredCached.mockRejectedValue(new Error('upstream is down'));
      mocks.fetchUsdcBalance.mockResolvedValue(0n);
      await expect(driver.preflight(job, input)).resolves.toBeUndefined();
    });

    it('refuses without a solana secret key', async () => {
      const bare = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        rpcUrl: 'http://127.0.0.1:1',
        getFeeBps: async () => 250,
        log: () => {},
      });
      await expect(bare.preflight(job, input)).rejects.toThrow(/bridge wallet missing/);
    });

    it('refuses when payments[] is empty (no vacuous pass)', async () => {
      const noPayments = new X402Driver({
        agentDir: dir,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1',
        getFeeBps: async () => 250,
        log: () => {},
      });
      await expect(noPayments.preflight(job, input)).rejects.toThrow(/no payments\[\] entry/);
    });

    it('refuses when the wallet invariant is broken', async () => {
      const other = await generateSolanaWallet();
      const broken = new X402Driver({
        agentDir: dir,
        paymentsAddress: other.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1',
        getFeeBps: async () => 250,
        log: () => {},
      });
      await expect(broken.preflight(job, input)).rejects.toThrow(/wallet invariant violated/);
    });

    it('refuses a skill not priced in devnet USDC', async () => {
      await expect(driver.preflight({ ...job, asset: NATIVE_SOL }, input)).rejects.toThrow(
        /priced in devnet USDC/,
      );
    });

    it('refuses an oversized GET input by percent-encoded bytes', async () => {
      const getJob: X402SkillJob = {
        ...job,
        params: { ...job.params, method: 'GET', queryParam: 'q' },
      };
      const cyrillic = 'ф'.repeat(1500); // ~9KB percent-encoded, only 1500 chars
      await expect(driver.preflight(getJob, { ...input, data: cyrillic })).rejects.toThrow(
        /GET input too large/,
      );
    });

    it('exposes a customer-safe message on input-size refusals', async () => {
      const oversized = { ...input, data: 'x'.repeat(200_000) };
      const error = await driver.preflight(job, oversized).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(X402PreflightError);
      expect((error as X402PreflightError).customerMessage).toMatch(/Input too large/);
    });

    it('refuses when no requirement is acceptable (over ceiling)', async () => {
      mocks.probePaymentRequiredCached.mockResolvedValue(acceptableProbe('999999'));
      await expect(driver.preflight(job, input)).rejects.toThrow(
        /no acceptable upstream payment requirement/,
      );
    });

    it('refuses when the probe fails', async () => {
      mocks.probePaymentRequiredCached.mockRejectedValue(new TypeError('fetch failed'));
      await expect(driver.preflight(job, input)).rejects.toThrow(/upstream unreachable/);
    });

    it('refuses on insufficient float balance', async () => {
      mocks.fetchUsdcBalance.mockResolvedValue(100n);
      await expect(driver.preflight(job, input)).rejects.toThrow(/bridge float insufficient/);
    });

    it('refuses on negative live margin', async () => {
      // price 10100, fee 250 bps => fee 253 => net 9847 < quote 10000
      mocks.probePaymentRequiredCached.mockResolvedValue(acceptableProbe('10000'));
      await expect(driver.preflight({ ...job, priceSubunits: 10_100 }, input)).rejects.toThrow(
        /negative margin/,
      );
    });

    it('checks margin/balance against the WORST acceptable quote, not the first', async () => {
      // Two acceptable requirements: cheap 3000, dear 10000 (both <= ceiling).
      // Signing may pick the dear one, so preflight must gate on 10000.
      mocks.probePaymentRequiredCached.mockResolvedValue(multiProbe('3000', '10000'));
      // Balance covers the cheap quote but not the dear one.
      mocks.fetchUsdcBalance.mockResolvedValue(5_000n);
      await expect(driver.preflight(job, input)).rejects.toThrow(/bridge float insufficient/);
    });
  });

  describe('execute', () => {
    function stubUpstream(
      paidResponse: () => Response,
      unpaidStatus = 402,
    ): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
          return paidResponse();
        }
        return new Response('payment required', { status: unpaidStatus });
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('pays once, caches a text result, and never re-pays for the same job', async () => {
      stubUpstream(
        () =>
          new Response('the result', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
      const first = await driver.execute(job, input);
      expect(first).toEqual({ data: 'the result' });
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(1);

      // Second run: cached, no fetch at all.
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const second = await driver.execute(job, input);
      expect(second).toEqual({ data: 'the result' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await store.paidAttempts(input.jobId)).toBe(1);
    });

    it('returns an unpaid 200 without recording a paid attempt', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('free content', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await driver.execute(job, input);
      expect(result.data).toBe('free content');
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(0);
    });

    it('stores a binary result as a cache file with mime and no cleanup', async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      stubUpstream(
        () => new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
      const result = await driver.execute(job, input);
      expect(result.outputMime).toBe('image/png');
      expect(result.data).toBe('');
      expect(result.filePath).toBeDefined();
      const store = new X402JobStore(dir);
      const cached = await store.getResult(input.jobId);
      expect(cached?.filePath).toBe(result.filePath);
    });

    it('classifies a paid 5xx as transient (keep-paid path) and records the attempt', async () => {
      stubUpstream(() => new Response('boom', { status: 503 }));
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402TransientError);
      // Money-unknown outcome (the upstream may have settled): the slot is
      // NOT refunded and there is NO inline retry - recovery owns it.
      expect(mocks.wrapFetchWithPayment).toHaveBeenCalledTimes(1);
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(1);
      expect(await store.paymentSignatures(input.jobId)).toBe(1);
    });

    it('refunds the slot on a 402 payment refusal and retries once with a fresh payment', async () => {
      let paidCalls = 0;
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
          paidCalls += 1;
          if (paidCalls === 1) {
            // First signed payment refused (e.g. blockhash expired before settle).
            return new Response('payment required', { status: 402 });
          }
          return new Response('the result', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response('payment required', { status: 402 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = await driver.execute(job, input);
      expect(result).toEqual({ data: 'the result' });
      const store = new X402JobStore(dir);
      // The refused attempt was refunded: one durable attempt, two signatures.
      expect(await store.paidAttempts(input.jobId)).toBe(1);
      expect(await store.paymentSignatures(input.jobId)).toBe(2);
    });

    it('gives up after one refunded retry, leaving the freed slots to recovery', async () => {
      stubUpstream(() => new Response('payment required', { status: 402 }));
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402TransientError);
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(0);
      expect(await store.paymentSignatures(input.jobId)).toBe(2);
    });

    it('turns a refuse-forever upstream permanent at the signature cap across re-executions', async () => {
      stubUpstream(() => new Response('payment required', { status: 402 }));
      // Two executions (original + recovery) burn two signatures each.
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402TransientError);
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402TransientError);
      // The third refuses to sign at all: no more money can ever leave.
      await expect(driver.execute(job, input)).rejects.toThrow(/signed payment budget exhausted/);
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(0);
      expect(await store.paymentSignatures(input.jobId)).toBe(X402_MAX_PAYMENT_SIGNATURES);
    });

    it('classifies an unpaid 4xx as permanent without burning the budget', async () => {
      const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402PermanentError);
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(0);
    });

    it('classifies a policy rejection as permanent', async () => {
      mocks.wrapFetchWithPayment.mockImplementationOnce(() => async () => {
        throw new Error(
          'Failed to create payment payload: All payment requirements were filtered out by policies',
        );
      });
      await expect(driver.execute(job, input)).rejects.toThrow(/payment refused by policy/);
    });

    it('retries a money-free network failure inline, then goes transient for recovery', async () => {
      const failingWrapper = () => async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      };
      // One implementation per attempt: initial + every inline retry.
      for (let i = 0; i < 1 + TEST_FREE_RETRY_DELAYS.length; i++) {
        mocks.wrapFetchWithPayment.mockImplementationOnce(failingWrapper);
      }
      await expect(driver.execute(job, input)).rejects.toBeInstanceOf(X402TransientError);
      expect(mocks.wrapFetchWithPayment).toHaveBeenCalledTimes(1 + TEST_FREE_RETRY_DELAYS.length);
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(0);
    });

    it('recovers inline from an unpaid 5xx without burning money', async () => {
      let unpaidCalls = 0;
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
          return new Response('the result', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        unpaidCalls += 1;
        if (unpaidCalls === 1) {
          // Unpaid 5xx: transient AND provably money-free -> inline retry.
          return new Response('flaky', { status: 503 });
        }
        return new Response('payment required', { status: 402 });
      });
      vi.stubGlobal('fetch', fetchMock);
      expect(await driver.execute(job, input)).toEqual({ data: 'the result' });
      const store = new X402JobStore(dir);
      expect(await store.paidAttempts(input.jobId)).toBe(1);
    });

    it('surfaces the keep-paid transient (not AbortError) when aborted mid-backoff', async () => {
      const fetchMock = vi.fn(async () => new Response('flaky', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);
      const abort = new AbortController();
      const slowDriver = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        getFeeBps: async () => 250,
        log: () => {},
        freeRetryDelaysMs: [60_000],
      });
      const outcome = slowDriver.execute(job, input, abort.signal).catch((error: unknown) => error);
      // Let the first attempt fail and the driver enter the backoff sleep.
      await new Promise((resolve) => setTimeout(resolve, 50));
      abort.abort();
      // The already-classified transient must win so the runtime keeps the job paid.
      expect(await outcome).toBeInstanceOf(X402TransientError);
    });

    it('stays on the keep-paid transient when the refund itself fails (no raw store error)', async () => {
      let paidCalls = 0;
      stubUpstream(() => {
        paidCalls += 1;
        return new Response('payment required', { status: 402 });
      });
      const refundSpy = vi
        .spyOn(X402JobStore.prototype, 'refundPaidAttempt')
        .mockRejectedValueOnce(new Error('disk full'));
      try {
        const error = await driver.execute(job, input).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(X402TransientError);
        expect((error as Error).message).toMatch(/402 after a payment attempt/);
        // The failed refund keeps the slot consumed and skips the inline retry.
        expect(paidCalls).toBe(1);
        const store = new X402JobStore(dir);
        expect(await store.paidAttempts(input.jobId)).toBe(1);
      } finally {
        refundSpy.mockRestore();
      }
    });

    it('refuses to pay once the attempt budget is exhausted', async () => {
      const store = new X402JobStore(dir);
      for (let attempt = 0; attempt < X402_MAX_PAID_ATTEMPTS; attempt++) {
        await store.claimPaidAttempt(
          input.jobId,
          X402_MAX_PAID_ATTEMPTS,
          X402_MAX_PAYMENT_SIGNATURES,
        );
      }
      // The wrapper still makes the initial UNPAID probe, but the budget gate
      // in the instrumented fetch throws before any PAYMENT-SIGNATURE request.
      const fetchMock = vi.fn(async () => new Response('payment required', { status: 402 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(driver.execute(job, input)).rejects.toThrow(/paid attempt budget exhausted/);
      // No paid request went out: no fetch call carried a payment header.
      for (const call of fetchMock.mock.calls) {
        const request = new Request(call[0] as RequestInfo, call[1] as RequestInit);
        expect(request.headers.has('PAYMENT-SIGNATURE')).toBe(false);
      }
      expect(await store.paidAttempts(input.jobId)).toBe(X402_MAX_PAID_ATTEMPTS);
    });

    it('does not exceed the budget under concurrent same-job execute() calls', async () => {
      // Both flows race past any stale check; the atomic claim caps paid
      // attempts at the budget, so at most 2 payment fetches ever go out.
      let paidFetches = 0;
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
          paidFetches += 1;
          return new Response('paid', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response('payment required', { status: 402 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const racing = Array.from({ length: 5 }, () =>
        driver.execute(job, input).catch(() => undefined),
      );
      await Promise.all(racing);
      expect(paidFetches).toBeLessThanOrEqual(X402_MAX_PAID_ATTEMPTS);
    });

    it('refuses a materialized file input before paying upstream', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        driver.execute(job, { ...input, filePath: '/tmp/materialized' }),
      ).rejects.toThrow(/file inputs are not supported/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('re-checks the actual input size before paying upstream', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(driver.execute(job, { ...input, data: 'x'.repeat(200_000) })).rejects.toThrow(
        /exceeds x402_max_input_bytes/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends JSON content-type only for structured bodies, not bare scalars', async () => {
      const seen: string[] = [];
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT')) {
          seen.push(request.headers.get('content-type') ?? '');
          return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response('payment required', { status: 402 });
      });
      vi.stubGlobal('fetch', fetchMock);

      await driver.execute(job, { ...input, data: '{"symbol":"SOL"}', jobId: 'd'.repeat(64) });
      // A bare valid-JSON scalar must NOT flip the content-type to JSON.
      await driver.execute(job, { ...input, data: '1234', jobId: 'e'.repeat(64) });
      await driver.execute(job, { ...input, data: 'plain text', jobId: 'f'.repeat(64) });

      expect(seen).toEqual(['application/json', 'text/plain', 'text/plain']);
    });

    it('maps GET input into the configured query param via searchParams', async () => {
      const getJob: X402SkillJob = {
        ...job,
        params: { ...job.params, method: 'GET', queryParam: 'q' },
      };
      let seenUrl = '';
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        seenUrl = request.url;
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      await driver.execute(getJob, { ...input, data: 'a b&c' });
      expect(seenUrl).toContain('q=a+b%26c');
    });

    it('rejects an oversized 402 challenge body during the handshake', async () => {
      // Hostile upstream: a giant 402 body the payment wrapper would read
      // uncapped. The instrumented fetch caps it before the wrapper sees it.
      const hugeChallenge = new Uint8Array(300 * 1024); // > 256 KiB challenge cap
      const fetchMock = vi.fn(
        async () =>
          new Response(hugeChallenge, {
            status: 402,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(driver.execute(job, input)).rejects.toThrow(/too large/);
    });

    it('rejects an oversized upstream response as permanent', async () => {
      const bigBody = new Uint8Array(10 * 1024 * 1024 + 1);
      stubUpstream(
        () =>
          new Response(bigBody, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
      );
      await expect(driver.execute(job, input)).rejects.toThrow(/upstream response too large/);
    });
  });
});
