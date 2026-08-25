import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  generateSolanaWallet,
} from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInput, X402SkillJob } from '../src/skill/index.js';
import {
  X402_MAX_CHALLENGE_HEADER_CHARS,
  X402_MAX_ERROR_BODY_READS,
  X402_MAX_PAID_ATTEMPTS,
  X402_MAX_PAYMENT_SIGNATURES,
  X402_SOLANA_DEVNET_CAIP2,
  X402_SOLANA_MAINNET_CAIP2,
  X402_SOLANA_MAINNET_V1,
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
  /** The base64 signed transaction the fake wrapper puts in the envelope. */
  signedTransaction: 'c2lnbmVkLXR4',
  // Simulates wrapFetchWithPayment: unpaid pass first; on 402, retry once
  // with a PAYMENT-SIGNATURE header through the SAME injected fetch (this
  // is the contract the instrumented attempt recording relies on).
  wrapFetchWithPayment: vi.fn(
    (fetchFn: typeof globalThis.fetch) =>
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // The real wrapper hands its fetch a single Request on both passes.
        const unpaid = await fetchFn(new Request(input, init));
        if (unpaid.status !== 402) {
          return unpaid;
        }
        // A realistic envelope: base64 JSON wrapping the signed transaction,
        // carrying the challenge's own extension declaration back exactly as
        // the real client does (`mergeExtensions` in @x402/core). An opaque
        // string would hide whether the driver can rewrite the header - and a
        // declaration-free one would hide whether the rewrite wrecks the echo
        // the server validates.
        const challenge = unpaid.headers.get('payment-required');
        const declared =
          challenge === null
            ? undefined
            : (
                JSON.parse(Buffer.from(challenge, 'base64').toString('utf8')) as {
                  extensions?: Record<string, unknown>;
                }
              ).extensions;
        const headers = new Headers(init?.headers);
        headers.set(
          'PAYMENT-SIGNATURE',
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: 'https://api.example.com/premium-data' },
              accepted: { scheme: 'exact', network: X402_SOLANA_DEVNET_CAIP2 },
              payload: { transaction: mocks.signedTransaction },
              ...(declared === undefined ? {} : { extensions: declared }),
            }),
            'utf8',
          ).toString('base64'),
        );
        // The real wrapper hands its fetch a single Request, not (url, init).
        return fetchFn(new Request(input, { ...init, headers }));
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

/**
 * A `payment-identifier` echo in either legal shape: wrapped in `info`, or
 * carrying its fields bare (which `@x402/core` reads as its own info).
 */
type IdentifierBlock = { info?: Record<string, unknown> } & Record<string, unknown>;

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
      network: 'devnet',
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
    mocks.signedTransaction = 'c2lnbmVkLXR4';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // `clearAllMocks` leaves an unconsumed `mockImplementationOnce` queued for
    // whichever test runs next; `resetAllMocks` drains it and restores the
    // implementation each `vi.fn` was defined with.
    vi.resetAllMocks();
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
        network: 'devnet',
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
        network: 'devnet',
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
        network: 'devnet',
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

    it('never masks the probe, which never carried the customer input', async () => {
      // The probe sends a URL and a method and nothing else, so a needle can
      // only ever blank the upstream's own words - and a customer sending
      // `Connection refused` would erase the operator's one real signal.
      const { X402ProbeError } = await import('../src/x402/probe.js');
      mocks.probePaymentRequiredCached.mockRejectedValue(
        new X402ProbeError('Connection refused by the upstream'),
      );
      const error = await driver
        .preflight(job, { ...input, data: 'Connection refused' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'upstream probe failed: Connection refused by the upstream',
      );
    });

    it('bounds and flattens an upstream that could not be reached at all', async () => {
      mocks.probePaymentRequiredCached.mockRejectedValue(
        new TypeError(`fetch failed\n  cause: ${'q'.repeat(50_000)}`),
      );
      const error = await driver.preflight(job, input).catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).toMatch(/^upstream unreachable: /);
      expect(message).not.toContain('\n');
      expect(message.length).toBeLessThan(600);
    });

    it('bounds and flattens an upstream refusal the probe wrapped for us', async () => {
      const { X402ProbeError } = await import('../src/x402/probe.js');
      mocks.probePaymentRequiredCached.mockRejectedValue(
        new X402ProbeError(
          `could not decode header: x\n  [job] 00000000 | delivered ${'q'.repeat(50_000)}`,
        ),
      );
      const error = await driver.preflight(job, input).catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).toMatch(/^upstream probe failed: /);
      expect(message).not.toContain('\n');
      expect(message.length).toBeLessThan(600);
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

    /** A 402 whose challenge header declares the `payment-identifier` extension. */
    function challengeDeclaringIdentifier(declaration: Record<string, unknown>): Response {
      const challenge = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [],
          extensions: { 'payment-identifier': declaration },
        }),
        'utf8',
      ).toString('base64');
      return new Response('payment required', {
        status: 402,
        headers: { 'payment-required': challenge },
      });
    }

    function challengeWithRequiredIdentifier(): Response {
      return challengeDeclaringIdentifier({ info: { required: true, scope: 'per-payment' } });
    }

    /** The `payment-identifier` block of an outgoing PAYMENT-SIGNATURE envelope. */
    function sentIdentifier(request: Request | undefined): IdentifierBlock | undefined {
      const header = request?.headers.get('PAYMENT-SIGNATURE') ?? null;
      if (header === null) {
        return undefined;
      }
      const envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
        extensions?: Record<string, IdentifierBlock>;
      };
      return envelope.extensions?.['payment-identifier'];
    }

    /** Upstream that answers `challenge` unpaid and the result once paid. */
    function stubIdentifierUpstream(challenge: () => Response): () => Request | undefined {
      let paidRequest: Request | undefined;
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE')) {
          paidRequest = request;
          return new Response('the result', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return challenge();
      });
      vi.stubGlobal('fetch', fetchMock);
      return () => paidRequest;
    }

    it('attaches a payment identifier when the challenge declares one as required', async () => {
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it('adds the identifier to the declaration it echoes back, never over it', async () => {
      // A server validates the echo by checking that everything it advertised
      // came back (`objectContainsSubset` in @x402/core). Replacing the echo
      // with a bare id is an `extension_echo_mismatch` - a burnt payment.
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info).toMatchObject({
        required: true,
        scope: 'per-payment',
      });
    });

    it('leaves the envelope alone when the declared identifier is not required', async () => {
      const paidRequest = stubIdentifierUpstream(() =>
        challengeDeclaringIdentifier({ info: { required: false } }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info).toEqual({ required: false });
    });

    it('keeps what the client itself put in the echo, including its own id', async () => {
      // A client extension could enrich the envelope past what the server
      // declared (`enrichPaymentPayload` in @x402/core); this driver registers
      // none, so today the echo always equals the declaration. Those fields
      // would be the client's, not ours to drop - and its id would outrank a
      // derived one.
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      mocks.wrapFetchWithPayment.mockImplementationOnce(
        (fetchFn: typeof globalThis.fetch) =>
          async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const unpaid = await fetchFn(target, init);
            if (unpaid.status !== 402) {
              return unpaid;
            }
            const headers = new Headers(init?.headers);
            headers.set(
              'PAYMENT-SIGNATURE',
              Buffer.from(
                JSON.stringify({
                  x402Version: 2,
                  payload: { transaction: 'c2lnbmVkLXR4' },
                  extensions: {
                    'payment-identifier': {
                      info: { required: true, scope: 'per-payment', id: 'client-chose-this' },
                      enrichedBy: 'a client extension',
                    },
                  },
                }),
                'utf8',
              ).toString('base64'),
            );
            return fetchFn(new Request(target, { ...init, headers }));
          },
      );

      await driver.execute(job, input);
      const identifier = sentIdentifier(paidRequest());
      expect(identifier?.info?.id).toBe('client-chose-this');
      expect(identifier?.enrichedBy).toBe('a client extension');
    });

    it('carries the declaration back even when the client echoed none', async () => {
      // The real client echoes the server's declaration into the envelope, so
      // the driver normally only has to add to it. A client that does not is
      // the case where the driver's own copy of the declaration is the only
      // thing standing between the payment and an echo mismatch.
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      mocks.wrapFetchWithPayment.mockImplementationOnce(
        (fetchFn: typeof globalThis.fetch) =>
          async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const unpaid = await fetchFn(target, init);
            if (unpaid.status !== 402) {
              return unpaid;
            }
            const headers = new Headers(init?.headers);
            headers.set(
              'PAYMENT-SIGNATURE',
              Buffer.from(
                JSON.stringify({ x402Version: 2, payload: { transaction: 'c2lnbmVkLXR4' } }),
                'utf8',
              ).toString('base64'),
            );
            return fetchFn(target, { ...init, headers });
          },
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info).toMatchObject({
        required: true,
        scope: 'per-payment',
      });
    });

    it('mirrors a declaration that carries its info bare, without an `info` wrapper', async () => {
      // `getExtensionInfo` in @x402/core treats a wrapper-less declaration as
      // its own info, so both shapes are legal - and an echo in the other
      // shape reads to the server as the declaration having gone missing.
      const paidRequest = stubIdentifierUpstream(() =>
        challengeDeclaringIdentifier({ required: true, scope: 'per-payment' }),
      );

      await driver.execute(job, input);
      const identifier = sentIdentifier(paidRequest());
      expect(identifier).toMatchObject({ required: true, scope: 'per-payment' });
      expect(identifier?.id).toMatch(/^pay_[a-f0-9]{32}$/);
      expect(identifier?.info).toBeUndefined();
    });

    it('leaves an identifier the server advertised itself alone', async () => {
      const paidRequest = stubIdentifierUpstream(() =>
        challengeDeclaringIdentifier({ info: { required: true, id: 'the-server-picked-this' } }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info?.id).toBe('the-server-picked-this');
    });

    /**
     * Two signed payments inside ONE job: the upstream refuses the first with
     * a 402, the driver refunds the slot and pays again. `challenge` is called
     * per unpaid answer, so a caller can vary the declaration between them.
     */
    function stubRefusedThenPaid(challenge: () => Response): () => (string | null)[] {
      const ids: (string | null)[] = [];
      let paidCalls = 0;
      const fetchMock = vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(info, init);
        if (request.headers.has('PAYMENT-SIGNATURE')) {
          paidCalls += 1;
          ids.push(sentIdentifier(request)?.info?.id ?? null);
          if (paidCalls === 1) {
            return challenge();
          }
          return new Response('the result', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return challenge();
      });
      vi.stubGlobal('fetch', fetchMock);
      return () => ids;
    }

    it('derives the identifier from the signed transaction, not from the envelope around it', async () => {
      // The declaration - and so the envelope's bytes - differs between the
      // two payments while the signed transaction does not. An id read off the
      // envelope would change here; one derived from the payment must not,
      // because this is the resend an upstream is meant to recognize.
      let challenges = 0;
      const ids = stubRefusedThenPaid(() => {
        challenges += 1;
        return challengeDeclaringIdentifier({
          info: { required: true, scope: 'per-payment', nonce: `challenge-${challenges}` },
        });
      });

      await driver.execute(job, input);
      const [first, second] = ids();
      expect(first).toMatch(/^pay_[a-f0-9]{32}$/);
      expect(second).toBe(first);
    });

    it('changes the identifier when the payment is re-signed', async () => {
      const ids = stubRefusedThenPaid(() => {
        // A fresh signature for the second attempt, as a real re-sign after an
        // expired blockhash would produce.
        mocks.signedTransaction = `re-signed-${mocks.signedTransaction}`;
        return challengeWithRequiredIdentifier();
      });

      await driver.execute(job, input);
      const [first, second] = ids();
      expect(second).not.toBe(first);
    });

    it('never shares an identifier between two jobs', async () => {
      // `@x402/svm` omits its per-payment memo nonce when the seller pinned an
      // `extra.memo`, so two concurrent jobs at one price can sign identical
      // transactions - and an upstream honouring a shared id would answer one
      // customer with the other's result.
      const first = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      await driver.execute(job, input);
      const second = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      await driver.execute(job, { ...input, jobId: 'd'.repeat(64) });

      expect(sentIdentifier(second())?.info?.id).not.toBe(sentIdentifier(first())?.info?.id);
    });

    it('learns the requirement from this attempt only, never from an earlier job', async () => {
      const demanding = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      await driver.execute(job, input);
      expect(sentIdentifier(demanding())?.info?.id).toBeDefined();

      // Same driver, a job whose upstream asks for nothing: the declaration
      // learned a moment ago must not follow it there.
      const quiet = stubIdentifierUpstream(() => new Response('payment required', { status: 402 }));
      await driver.execute(job, { ...input, jobId: 'f'.repeat(64) });
      expect(sentIdentifier(quiet())).toBeUndefined();
    });

    it('still produces an identifier when the envelope carries no transaction', async () => {
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      mocks.wrapFetchWithPayment.mockImplementationOnce(
        (fetchFn: typeof globalThis.fetch) =>
          async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const unpaid = await fetchFn(target, init);
            if (unpaid.status !== 402) {
              return unpaid;
            }
            const headers = new Headers(init?.headers);
            headers.set(
              'PAYMENT-SIGNATURE',
              Buffer.from(JSON.stringify({ x402Version: 2, payload: {} }), 'utf8').toString(
                'base64',
              ),
            );
            return fetchFn(target, { ...init, headers });
          },
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it('attaches nothing when the challenge declares extensions as an array', async () => {
      const challenge = Buffer.from(
        JSON.stringify({ x402Version: 2, accepts: [], extensions: [{ required: true }] }),
        'utf8',
      ).toString('base64');
      const paidRequest = stubIdentifierUpstream(
        () =>
          new Response('payment required', {
            status: 402,
            headers: { 'payment-required': challenge },
          }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())).toBeUndefined();
    });

    it('attaches nothing when the challenge declares a nonsense extensions block', async () => {
      const challenge = Buffer.from(
        JSON.stringify({ x402Version: 2, accepts: [], extensions: 'not-an-object' }),
        'utf8',
      ).toString('base64');
      const paidRequest = stubIdentifierUpstream(
        () =>
          new Response('payment required', {
            status: 402,
            headers: { 'payment-required': challenge },
          }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())).toBeUndefined();
    });

    /** A challenge whose encoded header is exactly `length` characters. */
    function challengeOfHeaderLength(length: number): Response {
      const payload = (note: string) =>
        JSON.stringify({
          x402Version: 2,
          accepts: [],
          extensions: { 'payment-identifier': { info: { required: true, note } } },
        });
      // Solved, not searched: base64 spends four characters on every three
      // bytes, so the note that lands on `length` exactly is arithmetic.
      // Shaving one character at a time re-encoded the whole header on every
      // step - fast enough here, and past the test timeout on a slower machine.
      const noteLength = (length / 4) * 3 - Buffer.byteLength(payload(''), 'utf8');
      const header = Buffer.from(payload('p'.repeat(noteLength)), 'utf8').toString('base64');
      if (header.length !== length) {
        throw new Error(`could not hit ${length}: got ${header.length}`);
      }
      return new Response('payment required', {
        status: 402,
        headers: { 'payment-required': header },
      });
    }

    it('reads a challenge far larger than any real one, well under the cap', async () => {
      // 20 KiB: above everything a facilitator would send, above Node's own
      // 16 KiB header limit, and still nowhere near the cap - a cap quietly
      // tightened to a plausible-looking size would lose the identifier here.
      const paidRequest = stubIdentifierUpstream(() => challengeOfHeaderLength(20 * 1024));

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it('still reads a challenge header of exactly the size cap', async () => {
      const paidRequest = stubIdentifierUpstream(() =>
        challengeOfHeaderLength(X402_MAX_CHALLENGE_HEADER_CHARS),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/);
    });

    it('adds nothing of its own to a challenge header past the size cap', async () => {
      const paidRequest = stubIdentifierUpstream(() =>
        challengeDeclaringIdentifier({
          info: { required: true, note: 'p'.repeat(X402_MAX_CHALLENGE_HEADER_CHARS * 2) },
        }),
      );

      await driver.execute(job, input);
      // The client's own echo still goes out untouched - the driver simply
      // adds nothing of its own to an oversized declaration.
      expect(sentIdentifier(paidRequest())?.info).toMatchObject({ required: true });
      expect(sentIdentifier(paidRequest())?.info?.id).toBeUndefined();
    });

    it('attaches nothing when a readable challenge declares no extensions', async () => {
      const challenge = Buffer.from(
        JSON.stringify({ x402Version: 2, accepts: [] }),
        'utf8',
      ).toString('base64');
      const paidRequest = stubIdentifierUpstream(
        () =>
          new Response('payment required', {
            status: 402,
            headers: { 'payment-required': challenge },
          }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())).toBeUndefined();
    });

    it('never breaks the payment on an envelope it cannot read', async () => {
      const paidRequest = stubIdentifierUpstream(challengeWithRequiredIdentifier);
      // Opaque header: the rewrite must pass it through, not throw. The
      // upstream then refuses it for the missing id - the same outcome as
      // before, rather than a crash on the money path.
      mocks.wrapFetchWithPayment.mockImplementationOnce(
        (fetchFn: typeof globalThis.fetch) =>
          async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const unpaid = await fetchFn(target, init);
            if (unpaid.status !== 402) {
              return unpaid;
            }
            const headers = new Headers(init?.headers);
            headers.set('PAYMENT-SIGNATURE', 'not-an-envelope');
            return fetchFn(target, { ...init, headers });
          },
      );

      await expect(driver.execute(job, input)).resolves.toEqual({ data: 'the result' });
      expect(paidRequest()?.headers.get('PAYMENT-SIGNATURE')).toBe('not-an-envelope');
    });

    it('leaves the envelope alone when the challenge asks for no identifier', async () => {
      const paidRequest = stubIdentifierUpstream(
        () => new Response('payment required', { status: 402 }),
      );

      await driver.execute(job, input);
      expect(sentIdentifier(paidRequest())).toBeUndefined();
    });

    it("quotes the upstream's own words on a failure, so a 4xx is diagnosable", async () => {
      stubUpstream(
        () =>
          new Response('{"error":"missing required extension payment-identifier"}', {
            status: 400,
          }),
      );
      await expect(driver.execute(job, input)).rejects.toThrow(
        /upstream returned 400.*payment-identifier/,
      );
    });

    it('caps and flattens the quoted body - an untrusted upstream cannot flood the log', async () => {
      stubUpstream(() => new Response(`x\u0007y\n${'A'.repeat(5_000)}`, { status: 400 }));
      const error = await driver.execute(job, input).catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).not.toContain('\u0007');
      expect(message).not.toContain('\n');
      expect(message.length).toBeLessThan(500);
      expect(message).toMatch(/\.\.\.$/);
    });

    /** A 5 MiB body of 'A', counting how much of it the driver actually pulls. */
    function countedBody(counter: { pulled: number }): ReadableStream<Uint8Array> {
      return new ReadableStream({
        pull(controller) {
          counter.pulled += 1_024;
          controller.enqueue(new Uint8Array(1_024).fill(0x41));
          if (counter.pulled >= 5 * 1024 * 1024) {
            controller.close();
          }
        },
      });
    }

    it('stops reading a failing body at the cap - the upstream does not decide the size', async () => {
      const counter = { pulled: 0 };
      stubUpstream(() => new Response(countedBody(counter), { status: 400 }));
      // An input with nothing to mask, so the cut body is still quoted and the
      // excerpt itself shows where the reader stopped.
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(`upstream returned 400: ${'A'.repeat(400)}...`);
      // Exactly the 8 KiB cap, plus the one chunk the stream keeps queued ahead
      // of the reader - not the whole body, and small enough that ten
      // concurrent failures stay cheap. Both ends are literals rather than the
      // constant, so a cap quietly raised, or lowered by more than that queued
      // chunk, fails here instead of moving the goalposts with itself.
      expect(counter.pulled).toBeLessThanOrEqual(9 * 1024);
      expect(counter.pulled).toBeGreaterThanOrEqual(8 * 1024);
    });

    it('quotes nothing from a body it had to cut short, rather than half an input', async () => {
      // The upstream echoes the input past the read cap: our own reader cuts
      // the echo in half, no needle matches the half that is left, and the
      // customer's data would ride into the operator's log on the excerpt.
      const secret = 'PATIENT-9f3a-SSN-123-45-6789';
      stubUpstream(
        () =>
          new Response(`{"error":"cannot parse","received":"${secret}${'x'.repeat(9_000)}"}`, {
            status: 400,
          }),
      );

      const error = await driver
        .execute(job, { ...input, data: `${secret}${'x'.repeat(9_000)}` })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400');
    });

    it('quotes nothing when a STALLED body stopped inside the input', async () => {
      // The deadline cuts the body the same way the byte cap does, and the
      // pending read resolves as `done` - so a body that never finished can
      // look finished. Half an echo matches no needle and would ride out.
      const secret = 'PATIENT-9f3a-SSN-123-45-6789-DOB-1974-02-11';
      const halfEcho = `{"error":"cannot parse","received":"${secret.slice(0, 20)}`;
      stubUpstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(halfEcho));
              },
              pull() {
                return new Promise<void>(() => {});
              },
            }),
            { status: 400 },
          ),
      );
      const impatient = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: () => {},
        errorBodyReadMs: 20,
      });

      const error = await impatient
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400');
    });

    it('quotes nothing when a cut lands mid-character inside the input', async () => {
      // The cut is on a byte: the character it splits decodes to U+FFFD, and a
      // tail ending in one matches no input - which would leave every
      // non-ASCII customer unprotected while ASCII ones stayed safe.
      // A non-ASCII echo cut by the byte cap: the printed window ends inside
      // the input, so the excerpt goes. (The replacement character that cut
      // leaves sits far past the window - the short-body test below is what
      // exercises stripping it.)
      const secret = '患'.repeat(4_000);
      stubUpstream(() => new Response(`x${secret}`, { status: 400 }));

      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400');
    });

    it('quotes nothing when a cut echo comes back URL-encoded', async () => {
      // A GET bridge's echo arrives encoded, so the tail the guard sees is the
      // encoded form - the half of the matching that matters most here.
      const getJob: X402SkillJob = {
        ...job,
        params: { ...job.params, method: 'GET', queryParam: 'q' },
      };
      const secret = 'jane doe 123-45-6789 '.repeat(500);
      const encoded = new URLSearchParams({ q: secret }).toString().slice('q='.length);
      stubUpstream(() => new Response(`{"url":"/v1/x?q=${encoded}"}`, { status: 400 }));

      const error = await driver
        .execute(getJob, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400');
    });

    it('quotes a body that ended on its own, even where the input would match', async () => {
      // Nothing was cut, so the tail is the upstream's last word rather than
      // half an echo - the guard has no business firing here.
      const secret = 'hello upstream and then some';
      stubUpstream(() => new Response('rejected: hello up', { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: rejected: hello up');
    });

    it('keeps a stalled body too short to end inside anything worth masking', async () => {
      stubUpstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('hello'));
              },
              pull() {
                return new Promise<void>(() => {});
              },
            }),
            { status: 400 },
          ),
      );
      const impatient = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: () => {},
        errorBodyReadMs: 20,
      });

      // Five characters cannot leak eight, and dropping every short excerpt
      // would cost the operator far more than it saves.
      const error = await impatient
        .execute(job, { ...input, data: 'hello upstream' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: hello');
    });

    it('strips every replacement character a ragged cut leaves behind', async () => {
      // A short stalled body, cut mid-character and then given two bytes that
      // continue nothing: the quote ends in three replacement characters, and
      // stripping only the last one would still hide the echo underneath.
      const secret = '患'.repeat(20);
      const ragged = new Uint8Array([...new TextEncoder().encode(secret).slice(0, 59), 0xff, 0xfe]);
      stubUpstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(ragged);
              },
              pull() {
                return new Promise<void>(() => {});
              },
            }),
            { status: 400 },
          ),
      );
      const impatient = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: () => {},
        errorBodyReadMs: 20,
      });

      const error = await impatient
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400');
    });

    it('keeps a diagnosis whose cut echo lies far past the printed excerpt', async () => {
      // The 8 KiB read stops a few characters into a trailing echo, so the
      // READ ends inside the input while the 400 characters actually printed
      // are the upstream's own words. Judging the whole read instead would
      // throw the operator's only explanation away.
      const secret = 'jane-doe-123-45-6789';
      stubUpstream(
        () =>
          new Response(`upstream says no because ${'z'.repeat(7_994)}${secret.repeat(50)}`, {
            status: 400,
          }),
      );

      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).toMatch(/^upstream returned 400: upstream says no because z+/);
      expect(message).not.toContain('jane');
    });

    it('still quotes a cut body that stopped somewhere harmless', async () => {
      // The echo is complete and masked; the cut lands far past it, so the
      // operator keeps a diagnosis rather than losing it to caution.
      const secret = 'jane-doe-123-45-6789';
      stubUpstream(
        () => new Response(`rejected ${secret} because ${'z'.repeat(9_000)}`, { status: 400 }),
      );
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).toMatch(/^upstream returned 400: rejected \[input\] because z+/);
      expect(message).not.toContain('jane');
    });

    it('still quotes a cut body when the job had no input worth masking', async () => {
      stubUpstream(() => new Response(`the reason${'x'.repeat(9_000)}`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: 'sol' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toMatch(/^upstream returned 400: the reason/);
    });

    it('gives up on a body that stalls, instead of holding the job open for it', async () => {
      const stalled = new ReadableStream<Uint8Array>({
        pull() {
          // A body whose next chunk never arrives: only a deadline ends this.
          return new Promise<void>(() => {});
        },
      });
      stubUpstream(() => new Response(stalled, { status: 400 }));
      const impatient = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: () => {},
        errorBodyReadMs: 20,
      });

      await expect(impatient.execute(job, input)).rejects.toThrow(/upstream returned 400$/);
    });

    it('gives up on a body that keeps yielding nothing, instead of spinning on it', async () => {
      let empties = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (empties < 50_000) {
            empties += 1;
            controller.enqueue(new Uint8Array(0));
            return;
          }
          controller.enqueue(new TextEncoder().encode('the explanation it was hiding'));
          controller.close();
        },
      });
      stubUpstream(() => new Response(body, { status: 400 }));

      // Reads are bounded as well as bytes: chunks that carry nothing make no
      // progress against a byte cap, so the read budget is what ends this.
      await expect(driver.execute(job, input)).rejects.toThrow(/upstream returned 400$/);
      // The 2048-read budget plus the chunk the stream prefetches behind it,
      // with an absolute ceiling so a budget loosened by much fails here
      // rather than moving the goalposts with it.
      expect(empties).toBeLessThanOrEqual(X402_MAX_ERROR_BODY_READS + 1);
      expect(empties).toBeLessThan(4_096);
    });

    it('keeps the customer input out of the operator log when the upstream echoes it', async () => {
      // Three occurrences, and an input whose escaped form differs from its
      // verbatim one: with fewer, or with a quote-free input, a mask that
      // replaced only the first occurrence per needle would look identical.
      const spoken = 'say "hi" 1234567';
      stubUpstream(() => new Response(`a ${spoken} b ${spoken} c ${spoken} d`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: spoken })
        .catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).not.toContain('1234567');
      expect(message).toBe('upstream returned 400: a [input] b [input] c [input] d');
    });

    it('masks the input as a GET bridge actually sends it - form-encoded in the query', async () => {
      const getJob: X402SkillJob = {
        ...job,
        params: { ...job.params, method: 'GET', queryParam: 'q' },
      };
      // The apostrophe and brackets are where `encodeURIComponent` and the
      // form encoding a query string really uses part ways.
      const secret = "jane o'doe (patient) 123-45-6789";
      const onTheWire = new URLSearchParams({ q: secret }).toString();
      stubUpstream(
        () => new Response(`{"error":"bad query","url":"/v1/x?${onTheWire}"}`, { status: 400 }),
      );
      const error = await driver
        .execute(getJob, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'upstream returned 400: {"error":"bad query","url":"/v1/x?q=[input]"}',
      );
    });

    it('masks a percent-encoded echo, not only the form-encoded one', async () => {
      // `%20` for the spaces is `encodeURIComponent`'s form, not the query
      // serializer's `+` - a URL an upstream reports back rather than one it
      // parsed out of the request line.
      const secret = 'patient jane doe 123-45-6789';
      stubUpstream(
        () =>
          new Response(`{"error":"bad query","url":"/v1/x?q=${encodeURIComponent(secret)}"}`, {
            status: 400,
          }),
      );
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain('jane');
    });

    it('masks an input that straddles the excerpt cut, before the cut is made', async () => {
      const secret = 'jane-doe-123-45-6789';
      stubUpstream(() => new Response(`${'p'.repeat(390)}${secret} tail`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      // Clipping first would have left the head of the input inside the quote.
      expect((error as Error).message).not.toContain('jane');
    });

    it('masks the input as the wire carried it, replacement characters and all', async () => {
      // An unpaired surrogate never reaches the upstream: both a UTF-8 body
      // and an encoded query substitute U+FFFD, so the echo comes back with
      // one and the raw needle no longer matches it.
      const secret = 'lone \ud800 surrogate in a record';
      stubUpstream(
        () =>
          new Response(`rejected ${new TextDecoder().decode(new TextEncoder().encode(secret))}`, {
            status: 400,
          }),
      );
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: rejected [input]');
    });

    it('still quotes the upstream when the input cannot be URL-encoded at all', async () => {
      stubUpstream(() => new Response('unsupported payload', { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: 'a lone \ud800 surrogate, long enough to mask' })
        .catch((caught: unknown) => caught);
      // The encoded needles are lost with the throw; the excerpt is not.
      expect((error as Error).message).toBe('upstream returned 400: unsupported payload');
    });

    it('masks an echo the upstream flattened, matching how the quote is read', async () => {
      const multiline = '{\n  "symbol": "SOL",\n  "depth": 20\n}';
      stubUpstream(() => new Response(`rejected ${multiline}`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: multiline })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: rejected [input]');
    });

    it('masks an input of exactly the minimum length, and one below it', async () => {
      const atFloor = 'a'.repeat(8);
      stubUpstream(() => new Response(`rejected ${atFloor} here`, { status: 400 }));
      const masked = await driver
        .execute(job, { ...input, data: atFloor })
        .catch((caught: unknown) => caught);
      expect((masked as Error).message).toBe('upstream returned 400: rejected [input] here');

      const belowFloor = 'a'.repeat(7);
      stubUpstream(() => new Response(`rejected ${belowFloor} here`, { status: 400 }));
      const untouched = await driver
        .execute(job, { ...input, jobId: 'b'.repeat(64), data: belowFloor })
        .catch((caught: unknown) => caught);
      expect((untouched as Error).message).toBe('upstream returned 400: rejected aaaaaaa here');
    });

    it('joins a body that arrives in several chunks', async () => {
      // A trickling upstream: keeping only the first chunk would quote a
      // fraction of the explanation and read as the whole of it.
      stubUpstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('first half '));
                controller.enqueue(new TextEncoder().encode('second half'));
                controller.close();
              },
            }),
            { status: 400 },
          ),
      );
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: first half second half');
    });

    it('quotes a body of exactly the excerpt length whole, and one past it clipped', async () => {
      stubUpstream(() => new Response('e'.repeat(400), { status: 400 }));
      const whole = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((whole as Error).message).toBe(`upstream returned 400: ${'e'.repeat(400)}`);

      stubUpstream(() => new Response('e'.repeat(401), { status: 400 }));
      const clipped = await driver
        .execute(job, { ...input, jobId: 'c'.repeat(64), data: '' })
        .catch((caught: unknown) => caught);
      expect((clipped as Error).message).toBe(`upstream returned 400: ${'e'.repeat(400)}...`);
    });

    it('keeps a character whose second half lands on the cut', async () => {
      // Char 399 is the LOW surrogate of a complete pair: a strip that took
      // the whole surrogate range would eat a character that fitted.
      stubUpstream(() => new Response(`${'a'.repeat(398)}\u{1f600}tail`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        `upstream returned 400: ${'a'.repeat(398)}\u{1f600}...`,
      );
    });

    it('never clips a character in half', async () => {
      // The 400-char cut falls between the two halves of the emoji.
      stubUpstream(() => new Response(`${'a'.repeat(399)}\u{1f600}tail`, { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      const message = (error as Error).message;
      expect(message).toBe(`upstream returned 400: ${'a'.repeat(399)}...`);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(message)).toBe(false);
    });

    it("trims the quote rather than quoting an upstream's indentation", async () => {
      stubUpstream(() => new Response('   \n  the reason  \n ', { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: the reason');
    });

    it('survives a single chunk larger than the whole budget', async () => {
      // One 5 MiB chunk rather than many small ones. The byte bound itself is
      // proven by the counted-body and cut-body tests; this is the smoke test
      // that a chunk bigger than the budget goes through the slicing at all.
      stubUpstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(0x41));
                controller.close();
              },
            }),
            { status: 400 },
          ),
      );
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(`upstream returned 400: ${'A'.repeat(400)}...`);
    });

    it('masks the input on a failure the wrapper reported, not only in a body', async () => {
      const getJob: X402SkillJob = {
        ...job,
        params: { ...job.params, method: 'GET', queryParam: 'q' },
      };
      const secret = 'patient jane doe 123-45-6789';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          // A GET bridge's input rides in the URL, and a wrapper failure can
          // quote the URL back.
          throw new Error(`connect ECONNREFUSED /v1/x?${new URLSearchParams({ q: secret })}`);
        }),
      );
      const error = await driver
        .execute(getJob, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain('jane');
    });

    it('leaves the quote alone for an input too short to mask honestly', async () => {
      stubUpstream(() => new Response('rate limit 100 requests/min', { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: '1' })
        .catch((caught: unknown) => caught);
      // Blanking a one-character needle would rewrite the upstream's numbers
      // and tell the operator the input appeared where it did not.
      expect((error as Error).message).toBe('upstream returned 400: rate limit 100 requests/min');
    });

    it('quotes the body untouched when the job carried no input at all', async () => {
      stubUpstream(() => new Response('missing parameter q', { status: 400 }));
      const error = await driver
        .execute(job, { ...input, data: '' })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: missing parameter q');
    });

    it('strips the invisible marks a control-character filter leaves behind', async () => {
      // A direction override, a zero-width space, and a tag character - all
      // survive C0/C1 stripping and all reorder or hide what the operator reads.
      // The byte-order mark is both a format mark and whitespace: collapsing
      // before stripping would leave it behind as a space.
      stubUpstream(
        () => new Response('bad\u202erequest\u200b\u{e0041}\ufeffhere', { status: 400 }),
      );
      const error = await driver.execute(job, input).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('upstream returned 400: badrequesthere');
    });

    it("keeps an upstream's escape sequences out of both the log and the error", async () => {
      const forged = 'boom\u001b[2K\rjob aaaaaaaa | delivered\nbogus line';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          // A failure the driver quotes into its own log line, carrying the
          // escape sequences a hostile upstream put in it.
          throw new Error(forged);
        }),
      );
      const lines: string[] = [];
      const loud = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: (line) => lines.push(line),
        freeRetryDelaysMs: [1],
      });

      const failure = await loud.execute(job, input).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(X402TransientError);
      expect(lines.length).toBeGreaterThan(0);
      for (const text of [...lines, (failure as Error).message]) {
        expect(text).not.toContain('\u001b');
        expect(text).not.toContain('\r');
        expect(text).not.toContain('\n');
      }
    });

    it('falls back to the bare status when the body cannot be read at all', async () => {
      stubUpstream(() => {
        const response = new Response('unreadable', { status: 400 });
        // Locked by another reader: `getReader()` throws, and a failure to
        // explain a failure must not become a failure of its own.
        response.body?.getReader();
        return response;
      });
      await expect(driver.execute(job, input)).rejects.toThrow(/upstream returned 400$/);
    });

    it('bounds an upstream failure a library wrapped for us, not just the body', async () => {
      // `@x402/core` embeds the whole `accepts` array in this message, so the
      // upstream chooses its length; the driver quotes it into an error the
      // runtime prints verbatim.
      const flood = `Failed to create payment payload: ${'q'.repeat(200_000)}`;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error(flood);
        }),
      );

      const error = await driver.execute(job, input).catch((caught: unknown) => caught);
      expect((error as Error).message).toMatch(/^payment refused by policy/);
      expect((error as Error).message.length).toBeLessThan(600);
    });

    it('classifies a policy refusal on the raw message, not the masked quote', async () => {
      // The customer's input contains the marker the classification keys on.
      // Masking runs on the quote only - matching the masked text would turn a
      // permanent refusal into a transient the recovery loop retries forever.
      const marker = 'Failed to create payment payload';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error(`${marker}: All payment requirements were filtered out`);
        }),
      );

      const error = await driver
        .execute(job, { ...input, data: marker })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(X402PermanentError);
      expect((error as Error).message).toMatch(/^payment refused by policy/);
    });

    it('masks an input straddling the cut on a wrapped failure too', async () => {
      const secret = 'jane-doe-123-45-6789';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error(`${'p'.repeat(390)}${secret} tail`);
        }),
      );
      const error = await driver
        .execute(job, { ...input, data: secret })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain('jane');
    });

    it("flattens a wrapped failure carrying the upstream's own newlines", async () => {
      // A JSON parse failure quotes its raw input back, and the sink prints
      // one line per line it is given.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Unexpected token \'x\', "x\n  [job] 00000000 | delivered"');
        }),
      );

      const error = await driver.execute(job, input).catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain('\n');
    });

    it('masks a JSON echo of an input that also needed flattening', async () => {
      // A quote makes the echo escaped; a double space makes the quote
      // flattened. Each needle alone misses one of the two.
      const spoken = 'the client said "no  thank  you" at 14:03';
      stubUpstream(
        () =>
          new Response(`{"error":"invalid body: ${JSON.stringify(spoken).slice(1, -1)}"}`, {
            status: 400,
          }),
      );
      const error = await driver
        .execute(job, { ...input, data: spoken })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'upstream returned 400: {"error":"invalid body: [input]"}',
      );
    });

    it('masks an input a JSON upstream quoted back with escapes', async () => {
      const payload = '{"symbol":"SOL","depth":5}';
      stubUpstream(
        () =>
          new Response(`{"error":"invalid body: ${JSON.stringify(payload).slice(1, -1)}"}`, {
            status: 400,
          }),
      );
      const error = await driver
        .execute(job, { ...input, data: payload })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain('symbol');
    });

    it('falls back to the bare status when the upstream sends no body', async () => {
      stubUpstream(
        () =>
          new Response(null, {
            status: 400,
          }),
      );
      await expect(driver.execute(job, input)).rejects.toThrow(/upstream returned 400$/);
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
        network: 'devnet',
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

    it('flattens a store failure it logs, where nothing else would', async () => {
      // This line quotes a store error rather than an upstream one, so it
      // never passed through `quoteUpstream`: the flatten in `log()` is its
      // only defense against a message that spans lines.
      stubUpstream(() => new Response('payment required', { status: 402 }));
      const lines: string[] = [];
      const loud = new X402Driver({
        agentDir: dir,
        paymentsAddress: wallet.signer.address,
        solanaSecretKeyBase58: wallet.secretKeyBase58,
        rpcUrl: 'http://127.0.0.1:1/never-used',
        network: 'devnet',
        getFeeBps: async () => 250,
        log: (line) => lines.push(line),
      });
      const refundSpy = vi
        .spyOn(X402JobStore.prototype, 'refundPaidAttempt')
        .mockRejectedValueOnce(new Error('disk full\u001b[2K\rjob aaaaaaaa | delivered'));
      try {
        await loud.execute(job, input).catch(() => {});
        const refundLine = lines.find((line) => line.includes('could not refund'));
        expect(refundLine).toBeDefined();
        expect(refundLine).not.toContain('\u001b');
        expect(refundLine).not.toContain('\r');
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

describe('X402Driver (mainnet agent)', () => {
  let dir: string;
  let wallet: Awaited<ReturnType<typeof generateSolanaWallet>>;
  let driver: X402Driver;
  let job: X402SkillJob;

  const input: SkillInput = {
    data: 'hello mainnet upstream',
    inputType: 'text',
    tags: ['market-data'],
    jobId: 'd'.repeat(64),
  };

  const MAINNET_MINT = USDC_SOLANA_MAINNET.mint ?? '';

  function mainnetRequirement(network: string = X402_SOLANA_MAINNET_CAIP2) {
    return {
      scheme: 'exact',
      network,
      amount: '5000',
      asset: MAINNET_MINT,
      payTo: 'PayToAddress11111111111111111111111111111111',
      maxTimeoutSeconds: 60,
      extra: {},
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-x402-driver-mainnet-'));
    wallet = await generateSolanaWallet();
    driver = new X402Driver({
      agentDir: dir,
      paymentsAddress: wallet.signer.address,
      solanaSecretKeyBase58: wallet.secretKeyBase58,
      rpcUrl: 'http://127.0.0.1:1/never-used',
      network: 'mainnet',
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
      asset: USDC_SOLANA_MAINNET,
    };
    mocks.fetchUsdcBalance.mockResolvedValue(1_000_000n);
    mocks.probePaymentRequiredCached.mockResolvedValue({
      x402Version: 2,
      accepts: [mainnetRequirement()],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('preflight passes for a mainnet requirement (CAIP-2 id + mainnet mint)', async () => {
    await expect(driver.preflight(job, input)).resolves.toBeUndefined();
  });

  it('preflight passes for the v1 mainnet alias ("solana")', async () => {
    mocks.probePaymentRequiredCached.mockResolvedValue({
      x402Version: 2,
      accepts: [mainnetRequirement(X402_SOLANA_MAINNET_V1)],
    });
    await expect(driver.preflight(job, input)).resolves.toBeUndefined();
  });

  it('reads the float balance with the mainnet mint (network threaded through)', async () => {
    await driver.preflight(job, input);
    expect(mocks.fetchUsdcBalance).toHaveBeenCalledWith(
      expect.anything(),
      wallet.signer.address,
      'mainnet',
    );
  });

  it('refuses a skill priced in devnet USDC on a mainnet agent', async () => {
    await expect(driver.preflight({ ...job, asset: USDC_SOLANA_DEVNET }, input)).rejects.toThrow(
      /priced in mainnet USDC/,
    );
  });

  it('refuses a devnet-settling upstream (cross-network requirement)', async () => {
    mocks.probePaymentRequiredCached.mockResolvedValue({
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: X402_SOLANA_DEVNET_CAIP2,
          amount: '5000',
          asset: USDC_SOLANA_DEVNET.mint ?? '',
          payTo: 'PayToAddress11111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    });
    await expect(driver.preflight(job, input)).rejects.toThrow(
      /no acceptable upstream payment requirement/,
    );
  });
});
