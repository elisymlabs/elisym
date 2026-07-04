import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearProbeCache,
  probePaymentRequired,
  probePaymentRequiredCached,
} from '../src/x402/probe.js';

const V2_PAYMENT_REQUIRED = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: {
    url: 'https://api.example.com/premium-data',
    description: 'Premium market data',
    serviceName: 'Example Data',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const,
      amount: '5000',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
      maxTimeoutSeconds: 60,
      extra: { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' },
    },
  ],
};

function stubFetchOnce(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearProbeCache();
});

describe('probePaymentRequired', () => {
  it('parses a v2 PAYMENT-REQUIRED header', async () => {
    stubFetchOnce(
      new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(V2_PAYMENT_REQUIRED) },
      }),
    );
    const result = await probePaymentRequired('https://api.example.com/premium-data', 'POST');
    expect(result.x402Version).toBe(2);
    expect(result.accepts).toHaveLength(1);
    expect(result.accepts[0]?.amount).toBe('5000');
    expect(result.resource?.description).toBe('Premium market data');
  });

  it('falls back to a v1 JSON body and normalizes maxAmountRequired', async () => {
    const v1Body = {
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [
        {
          scheme: 'exact',
          network: 'solana-devnet',
          maxAmountRequired: '7000',
          asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
          resource: 'https://api.example.com/premium-data',
          description: 'Premium market data (v1)',
          maxTimeoutSeconds: 60,
        },
      ],
    };
    stubFetchOnce(new Response(JSON.stringify(v1Body), { status: 402 }));
    const result = await probePaymentRequired('https://api.example.com/premium-data', 'POST');
    expect(result.x402Version).toBe(1);
    expect(result.accepts[0]?.amount).toBe('7000');
    expect(result.accepts[0]?.network).toBe('solana-devnet');
    expect(result.resource?.description).toBe('Premium market data (v1)');
  });

  it('does not follow redirects (SSRF guard)', async () => {
    const fetchMock = stubFetchOnce(
      new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(V2_PAYMENT_REQUIRED) },
      }),
    );
    await probePaymentRequired('https://api.example.com/premium-data', 'POST');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/premium-data',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('rejects an oversized v1 402 body instead of buffering it (OOM guard)', async () => {
    const huge = 'x'.repeat(300 * 1024); // > 256 KiB probe body cap
    stubFetchOnce(new Response(huge, { status: 402 }));
    await expect(
      probePaymentRequired('https://api.example.com/premium-data', 'POST'),
    ).rejects.toThrow(/exceeds .* bytes/);
  });

  it('probes with the declared method', async () => {
    const fetchMock = stubFetchOnce(
      new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(V2_PAYMENT_REQUIRED) },
      }),
    );
    await probePaymentRequired('https://api.example.com/premium-data', 'GET');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/premium-data',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects a non-402 response with the status in the message', async () => {
    stubFetchOnce(new Response('not paid content', { status: 200 }));
    await expect(
      probePaymentRequired('https://api.example.com/premium-data', 'POST'),
    ).rejects.toThrow(/expected HTTP 402.*got 200/);
  });

  it('rejects a 402 with neither header nor parseable v1 body', async () => {
    stubFetchOnce(new Response('payment required', { status: 402 }));
    await expect(
      probePaymentRequired('https://api.example.com/premium-data', 'POST'),
    ).rejects.toThrow(/neither a v2 PAYMENT-REQUIRED header nor a v1 JSON body/);
  });

  it('does not throw on null/scalar entries in a v1 accepts array', async () => {
    // Hostile upstream: accepts full of non-objects would TypeError a naive map.
    const body = { x402Version: 1, accepts: [null, 42, 'x'] };
    stubFetchOnce(new Response(JSON.stringify(body), { status: 402 }));
    await expect(
      probePaymentRequired('https://api.example.com/premium-data', 'POST'),
    ).rejects.toThrow(/neither a v2 PAYMENT-REQUIRED header nor a v1 JSON body/);
  });
});

describe('probePaymentRequiredCached', () => {
  it('serves repeat probes within the TTL from cache', async () => {
    const fetchMock = stubFetchOnce(
      new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(V2_PAYMENT_REQUIRED) },
      }),
    );
    const first = await probePaymentRequiredCached('https://api.example.com/a', 'POST', 30_000);
    const second = await probePaymentRequiredCached('https://api.example.com/a', 'POST', 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('keys the cache by method and url', async () => {
    const fetchMock = stubFetchOnce(
      new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(V2_PAYMENT_REQUIRED) },
      }),
    );
    await probePaymentRequiredCached('https://api.example.com/a', 'POST', 30_000);
    await probePaymentRequiredCached('https://api.example.com/a', 'GET', 30_000);
    await probePaymentRequiredCached('https://api.example.com/b', 'POST', 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
