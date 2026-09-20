/**
 * The wire tags that name a settlement chain, and the job history that reads
 * them back.
 *
 * The misread this guards: a v2 payment request fails the v1 parser, the job is
 * left with NO asset, and every consumer reads "no asset" as lamports - 0.05
 * USDC.e shown as 0.00005 SOL.
 */
import { finalizeEvent, type Event, type Filter } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import { KIND_JOB_FEEDBACK, KIND_JOB_REQUEST, KIND_JOB_RESULT } from '../src/constants';
import { PATHUSD_TEMPO } from '../src/payment/assets';
import { ElisymIdentity } from '../src/primitives/identity';
import { MarketplaceService } from '../src/services/marketplace';
import type { NostrPool } from '../src/transport/pool';

const TEMPO_DEVNET = 'eip155:42431';
const RECIPIENT = '0x716ebf6bef1c3f27ea5c315ecfc60527d97041a2';
const EVM_HASH = `0x${'c4'.repeat(32)}`;
const SOLANA_SIG = '5'.repeat(88);

function publishingPool(): NostrPool & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    publishAll: vi.fn(async (event: Event) => {
      published.push(event);
    }),
    publish: vi.fn(),
    getRelays: vi.fn().mockReturnValue([]),
  } as unknown as NostrPool & { published: Event[] };
}

function historyPool(requests: Event[], feedbacks: Event[], results: Event[] = []): NostrPool {
  return {
    querySync: vi.fn().mockResolvedValue(requests),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn(async (filter: Filter) => {
      if (filter.kinds?.includes(KIND_JOB_FEEDBACK)) {
        return feedbacks;
      }
      return filter.kinds?.includes(KIND_JOB_RESULT) ? results : [];
    }),
    getRelays: vi.fn().mockReturnValue([]),
  } as unknown as NostrPool;
}

function jobRequest(customer: ElisymIdentity, providerPubkey: string): Event {
  return finalizeEvent(
    {
      kind: KIND_JOB_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'elisym'],
        ['t', 'general'],
        ['p', providerPubkey],
      ],
      content: 'hello',
    },
    customer.secretKey,
  );
}

function feedback(author: ElisymIdentity, request: Event, tags: string[][]): Event {
  return finalizeEvent(
    {
      kind: KIND_JOB_FEEDBACK,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', request.id], ['p', request.pubkey], ...tags, ['t', 'elisym']],
      content: '',
    },
    author.secretKey,
  );
}

function v2Request(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    chain: TEMPO_DEVNET,
    asset: `${TEMPO_DEVNET}/erc20:${PATHUSD_TEMPO.mint}`,
    recipient: RECIPIENT,
    amount: '50000',
    memo: `0x${'5a'.repeat(32)}`,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
    ...overrides,
  });
}

describe('the chain element of a settlement tag', () => {
  it("stays 'solana' for every existing caller", async () => {
    const pool = publishingPool();
    const service = new MarketplaceService(pool);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);

    await service.submitPaymentConfirmation(customer, request.id, provider.publicKey, SOLANA_SIG);
    await service.submitFeedback(customer, request.id, provider.publicKey, true, undefined, {
      txSignature: SOLANA_SIG,
    });
    await service.submitPaymentRequiredFeedback(provider, request, 1_000_000, '{"amount":1}');

    expect(pool.published[0]?.tags).toContainEqual(['tx', SOLANA_SIG, 'solana']);
    expect(pool.published[1]?.tags).toContainEqual(['tx', SOLANA_SIG, 'solana']);
    expect(pool.published[2]?.tags).toContainEqual(['amount', '1000000', '{"amount":1}', 'solana']);
  });

  it('is the CAIP-2 id the caller passes for an EVM settlement', async () => {
    const pool = publishingPool();
    const service = new MarketplaceService(pool);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);

    await service.submitPaymentConfirmation(
      customer,
      request.id,
      provider.publicKey,
      EVM_HASH,
      'devnet',
      TEMPO_DEVNET,
    );
    await service.submitFeedback(customer, request.id, provider.publicKey, true, undefined, {
      txSignature: EVM_HASH,
      chain: TEMPO_DEVNET,
    });
    await service.submitPaymentRequiredFeedback(
      provider,
      request,
      50_000,
      v2Request(),
      TEMPO_DEVNET,
    );

    expect(pool.published[0]?.tags).toContainEqual(['tx', EVM_HASH, TEMPO_DEVNET]);
    expect(pool.published[1]?.tags).toContainEqual(['tx', EVM_HASH, TEMPO_DEVNET]);
    expect(pool.published[2]?.tags.find((tag) => tag[0] === 'amount')?.[3]).toBe(TEMPO_DEVNET);
  });

  it.each(['tempo', 'eip155:1', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', ''])(
    'throws on %j instead of writing it: the value is ours, so it is a bug',
    async (chain) => {
      const pool = publishingPool();
      const service = new MarketplaceService(pool);
      const customer = ElisymIdentity.generate();
      const provider = ElisymIdentity.generate();
      const request = jobRequest(customer, provider.publicKey);
      await expect(
        service.submitPaymentConfirmation(
          customer,
          request.id,
          provider.publicKey,
          EVM_HASH,
          'devnet',
          chain,
        ),
      ).rejects.toThrow(/settlement chain/);
      await expect(
        service.submitPaymentRequiredFeedback(provider, request, 50_000, v2Request(), chain),
      ).rejects.toThrow(/settlement chain/);
      await expect(
        service.submitFeedback(customer, request.id, provider.publicKey, true, undefined, {
          txSignature: EVM_HASH,
          chain,
        }),
      ).rejects.toThrow(/settlement chain/);
      expect(pool.published).toHaveLength(0);
    },
  );
});

describe('an EVM settlement is written in the form the reader keeps', () => {
  it.each([
    ['an uppercase hash', `0x${'C4'.repeat(32)}`],
    ['a Solana signature', SOLANA_SIG],
    ['a short hash', '0xdead'],
  ])('refuses to write %s under an EVM chain', async (_label, hash) => {
    const pool = publishingPool();
    const service = new MarketplaceService(pool);
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);
    await expect(
      service.submitPaymentConfirmation(
        customer,
        request.id,
        provider.publicKey,
        hash,
        'devnet',
        TEMPO_DEVNET,
      ),
    ).rejects.toThrow(/lowercase 0x transaction hash/);
    await expect(
      service.submitFeedback(customer, request.id, provider.publicKey, true, undefined, {
        txSignature: hash,
        chain: TEMPO_DEVNET,
      }),
    ).rejects.toThrow(/lowercase 0x transaction hash/);
    expect(pool.published).toHaveLength(0);
  });
});

describe('the payment-required tag says what the blob says', () => {
  const V1_BLOB = JSON.stringify({
    recipient: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    amount: 1_000_000,
    reference: 'EWj2cuEuVhi7RX81cnAY3TzpyFwnHzzVwvuTyfmxmhs3',
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
  });

  it('keeps the caller tag when the blob is one neither parser accepts', async () => {
    const pool = publishingPool();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(ElisymIdentity.generate(), provider.publicKey);
    await new MarketplaceService(pool).submitPaymentRequiredFeedback(
      provider,
      request,
      50_000,
      '{"amount":1}',
      TEMPO_DEVNET,
    );
    expect(pool.published[0]?.tags.find((tag) => tag[0] === 'amount')?.[3]).toBe(TEMPO_DEVNET);
  });

  it('takes the chain from a v2 request when the caller names none', async () => {
    const pool = publishingPool();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(ElisymIdentity.generate(), provider.publicKey);
    await new MarketplaceService(pool).submitPaymentRequiredFeedback(
      provider,
      request,
      50_000,
      v2Request(),
    );
    expect(pool.published[0]?.tags.find((tag) => tag[0] === 'amount')?.[3]).toBe(TEMPO_DEVNET);
  });

  it.each([
    ['a v1 request under an EVM tag', V1_BLOB, TEMPO_DEVNET],
    ['a Moderato request under the mainnet tag', v2Request(), 'eip155:4217'],
    ['a v2 request under the Solana tag', v2Request(), 'solana'],
  ])('refuses %s', async (_label, blob, chain) => {
    // A mis-tagged request is read by history as the wrong currency.
    const pool = publishingPool();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(ElisymIdentity.generate(), provider.publicKey);
    await expect(
      new MarketplaceService(pool).submitPaymentRequiredFeedback(
        provider,
        request,
        50_000,
        blob,
        chain,
      ),
    ).rejects.toThrow(/does not match the payment request/);
    expect(pool.published).toHaveLength(0);
  });
});

describe('job history over a v2 payment request', () => {
  async function historyOf(amountTag: string[], extra: string[][] = []) {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);
    const required = feedback(provider, request, [['status', 'payment-required'], amountTag]);
    const paid = extra.length > 0 ? [feedback(customer, request, extra)] : [];
    const jobs = await new MarketplaceService(
      historyPool([request], [required, ...paid]),
    ).fetchRecentJobs();
    expect(jobs).toHaveLength(1);
    return jobs[0];
  }

  it('takes the asset from the REGISTRY, by the chain and contract the request names', async () => {
    const job = await historyOf(['amount', '50000', v2Request(), TEMPO_DEVNET]);
    expect(job?.asset).toEqual({
      chain: 'tempo',
      token: 'pathusd',
      mint: PATHUSD_TEMPO.mint,
      decimals: 6,
    });
    expect(job?.amount).toBe(50_000);
  });

  it('shows NO amount for a coin the registry does not hold - never lamports', async () => {
    const unknownCoin = v2Request({
      asset: `${TEMPO_DEVNET}/erc20:0x20c00000000000000000000014f22ca97301eb73`,
    });
    const job = await historyOf(['amount', '50000', unknownCoin, TEMPO_DEVNET]);
    expect(job?.asset).toBeUndefined();
    expect(job?.amount).toBeUndefined();
  });

  it('shows NO amount for a request version this SDK does not know', async () => {
    const future = JSON.stringify({ v: 3, anything: true });
    const job = await historyOf(['amount', '50000', future, TEMPO_DEVNET]);
    expect(job?.asset).toBeUndefined();
    expect(job?.amount).toBeUndefined();
  });

  it.each([['not json'], ['42'], ['null'], ['[]'], ['{"recipient":"x"}'], ['']])(
    'shows NO amount when the tag names an EVM chain and the blob is %j',
    async (blob) => {
      // The tag already says the amount is not lamports, whatever the blob is -
      // an EMPTY blob included, which never reaches the parser.
      const job = await historyOf(['amount', '50000', blob, TEMPO_DEVNET]);
      expect(job?.asset).toBeUndefined();
      expect(job?.amount).toBeUndefined();
    },
  );

  it.each([['eip155:1'], ['bitcoin'], ['SOLANA'], ['']])(
    'shows NO amount when the chain element is %j: anything but the literal solana is off Solana',
    async (chainElement) => {
      // NOT "a registry EVM chain": the rule for an amount is wider than the rule
      // for a tx hash, because an unknown chain's amount is still not lamports.
      const job = await historyOf(['amount', '50000', 'not json', chainElement]);
      expect(job?.amount).toBeUndefined();
    },
  );

  it('keeps a Solana signature under a SOLANA CAIP-2 chain element: only an EVM chain is shape-gated', async () => {
    // No elisym client writes this form, but a registry chain that is not EVM must
    // not be treated as one - the third partition beside "absent" and "unknown".
    const job = await historyOf(
      ['amount', '1000000'],
      [
        ['status', 'payment-completed'],
        ['tx', SOLANA_SIG, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
      ],
    );
    expect(job?.txHash).toBe(SOLANA_SIG);
  });

  it('keeps a tx tag on a chain outside the registry exactly as it always was', async () => {
    const amountTag = ['amount', '1000000'];
    const job = await historyOf(amountTag, [
      ['status', 'payment-completed'],
      ['tx', 'anything-at-all', 'eip155:1'],
    ]);
    expect(job?.txHash).toBe('anything-at-all');
  });

  it.each([
    [
      'a v2 request for an unknown coin',
      () =>
        v2Request({ asset: `${TEMPO_DEVNET}/erc20:0x20c00000000000000000000014f22ca97301eb73` }),
    ],
    ['a request version this SDK does not know', () => JSON.stringify({ v: 3, anything: true })],
    ['a v2 request that fails its schema', () => v2Request({ memo: '0x00' })],
  ])(
    'shows NO amount for %s even under a MIS-TAGGED solana chain element',
    async (_label, build) => {
      // The blob is the second witness: a provider that tags a v2 request 'solana',
      // or leaves the chain element out, must not get its amount read as lamports.
      expect((await historyOf(['amount', '50000', build(), 'solana']))?.amount).toBeUndefined();
      expect((await historyOf(['amount', '50000', build()]))?.amount).toBeUndefined();
    },
  );

  it('keeps the amount of an ordinary SOLANA job, whatever else its provider published', async () => {
    // Every real job has provider feedback with NO amount tag (`processing`). An
    // absent chain element is not "off Solana": a reader that forgets that blanks
    // the amount of every Solana job in every history.
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);
    const v1 = JSON.stringify({
      recipient: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      amount: 1_000_000,
      reference: 'EWj2cuEuVhi7RX81cnAY3TzpyFwnHzzVwvuTyfmxmhs3',
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
    });
    for (const amountTag of [
      ['amount', '1000000', v1, 'solana'],
      ['amount', '1000000', v1], // legacy: no chain element
      ['amount', '1000000'], // legacy: no request at all
    ]) {
      const events = [
        feedback(provider, request, [['status', 'processing']]),
        feedback(provider, request, [['status', 'payment-required'], amountTag]),
        feedback(customer, request, [
          ['status', 'payment-completed'],
          ['tx', SOLANA_SIG], // legacy: no chain element
        ]),
      ];
      const result = finalizeEvent(
        {
          kind: KIND_JOB_RESULT,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['e', request.id],
            ['p', customer.publicKey],
            ['amount', '1000000'],
            ['t', 'elisym'],
          ],
          content: 'done',
        },
        provider.secretKey,
      );
      const jobs = await new MarketplaceService(
        historyPool([request], events, [result]),
      ).fetchRecentJobs();
      expect(jobs[0]?.status).toBe('success');
      expect(jobs[0]?.amount).toBe(1_000_000);
      expect(jobs[0]?.txHash).toBe(SOLANA_SIG);
    }
  });

  it('takes the asset only from the BOUND provider: a stranger cannot blank or re-denominate an amount', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const stranger = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);
    const events = [
      feedback(provider, request, [
        ['status', 'payment-required'],
        ['amount', '1000000'],
      ]),
      feedback(stranger, request, [
        ['status', 'payment-required'],
        ['amount', '50000', v2Request(), TEMPO_DEVNET],
      ]),
    ];
    const jobs = await new MarketplaceService(historyPool([request], events)).fetchRecentJobs();
    expect(jobs[0]?.asset).toBeUndefined();
    expect(jobs[0]?.amount).toBe(1_000_000);
  });

  it('ignores a tx tag published by anyone but the customer', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const stranger = ElisymIdentity.generate();
    const request = jobRequest(customer, provider.publicKey);
    const forged = feedback(stranger, request, [
      ['status', 'payment-completed'],
      ['tx', EVM_HASH, TEMPO_DEVNET],
    ]);
    const jobs = await new MarketplaceService(historyPool([request], [forged])).fetchRecentJobs();
    expect(jobs[0]?.txHash).toBeUndefined();
  });

  it('shows NO amount for a v2 request that fails its schema', async () => {
    // A v2 blob this SDK refuses is still not a lamports amount.
    const malformed = v2Request({ memo: '0x00' });
    const job = await historyOf(['amount', '50000', malformed, TEMPO_DEVNET]);
    expect(job?.asset).toBeUndefined();
    expect(job?.amount).toBeUndefined();
  });

  it('keeps an EVM tx hash only in its wire form', async () => {
    const paidTags = (hash: string): string[][] => [
      ['status', 'payment-completed'],
      ['tx', hash, TEMPO_DEVNET],
    ];
    const amountTag = ['amount', '50000', v2Request(), TEMPO_DEVNET];
    expect((await historyOf(amountTag, paidTags(EVM_HASH)))?.txHash).toBe(EVM_HASH);
    expect((await historyOf(amountTag, paidTags(EVM_HASH.toUpperCase())))?.txHash).toBeUndefined();
    // Lowercase prefix, uppercase digits: only the case rule refuses this one.
    const mixedCase = `0x${'C4'.repeat(32)}`;
    expect((await historyOf(amountTag, paidTags(mixedCase)))?.txHash).toBeUndefined();
    expect((await historyOf(amountTag, paidTags('0xdead')))?.txHash).toBeUndefined();
    expect((await historyOf(amountTag, paidTags(SOLANA_SIG)))?.txHash).toBeUndefined();
  });

  it.each([
    [
      'a v1 request that fails its schema (an expiry of two days)',
      (now: number) =>
        JSON.stringify({
          recipient: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
          amount: 1_000_000,
          reference: 'EWj2cuEuVhi7RX81cnAY3TzpyFwnHzzVwvuTyfmxmhs3',
          created_at: now,
          expiry_secs: 172_800,
        }),
    ],
    ['a blob that is not JSON', () => 'not json at all'],
    ['JSON that is not an object', () => '42'],
  ])('keeps the amount and the tx of a SOLANA job whose request is %s', async (_label, build) => {
    // Only a v2 blob, or a version this SDK does not know, may blank an amount.
    const job = await historyOf(
      ['amount', '1000000', build(Math.floor(Date.now() / 1000)), 'solana'],
      [
        ['status', 'payment-completed'],
        ['tx', SOLANA_SIG, 'solana'],
      ],
    );
    expect(job?.amount).toBe(1_000_000);
    expect(job?.txHash).toBe(SOLANA_SIG);
  });

  it('reads a Solana tx tag exactly as before', async () => {
    const v1 = JSON.stringify({
      recipient: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      amount: 1_000_000,
      reference: 'EWj2cuEuVhi7RX81cnAY3TzpyFwnHzzVwvuTyfmxmhs3',
      created_at: Math.floor(Date.now() / 1000),
      expiry_secs: 600,
    });
    const job = await historyOf(
      ['amount', '1000000', v1, 'solana'],
      [
        ['status', 'payment-completed'],
        ['tx', SOLANA_SIG, 'solana'],
      ],
    );
    expect(job?.txHash).toBe(SOLANA_SIG);
    expect(job?.asset).toBeUndefined();
    expect(job?.amount).toBe(1_000_000);
  });
});
