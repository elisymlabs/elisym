import { finalizeEvent, type Event } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PROOF_TTL_SECS,
  PROOF_CLOCK_SKEW_SECS,
  buildDelegationAuthProof,
  mintDelegationNonce,
} from '../src/delegation/auth-proof';
import { generateSolanaWallet } from '../src/payment/wallet';
import { ElisymIdentity } from '../src/primitives/identity';
import { MarketplaceService, parseDelegatedPayment } from '../src/services/marketplace';
import type { NostrPool } from '../src/transport/pool';
import type { SubCloser } from '../src/types';

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

async function delegatedFixture() {
  const customer = ElisymIdentity.generate();
  const provider = ElisymIdentity.generate();
  const owner = await generateSolanaWallet();
  const delegate = await generateSolanaWallet();
  const expiryUnix = Math.floor(Date.now() / 1000) + 300;
  const nonce = mintDelegationNonce();
  const proof = await buildDelegationAuthProof({
    ownerSigner: owner.signer,
    agentDelegate: delegate.signer.address,
    nostrAuthor: customer.publicKey,
    owner: owner.signer.address,
    expiryUnix,
    nonce,
  });
  return {
    customer,
    provider,
    delegatedPayment: { owner: owner.signer.address, expiryUnix, nonce, proof },
  };
}

describe('submitJobRequest delegated tags', () => {
  it('emits the five public top-level tags on a targeted job', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, provider, delegatedPayment } = await delegatedFixture();

    await svc.submitJobRequest(customer, {
      input: 'do the work',
      capability: 'text-gen',
      providerPubkey: provider.publicKey,
      delegatedPayment,
    });

    expect(pool.published).toHaveLength(1);
    const ev = pool.published[0]!;
    const tagValue = (name: string) => ev.tags.find((tag) => tag[0] === name)?.[1];
    expect(tagValue('payment')).toBe('delegated');
    expect(tagValue('delegation_owner')).toBe(delegatedPayment.owner);
    expect(tagValue('delegation_expiry')).toBe(String(delegatedPayment.expiryUnix));
    expect(tagValue('delegation_nonce')).toBe(delegatedPayment.nonce);
    expect(tagValue('delegation_proof')).toBe(delegatedPayment.proof);
    // Tags stay public; only content is encrypted.
    expect(ev.tags.find((tag) => tag[0] === 'encrypted')?.[1]).toBe('nip44');

    // Round-trips through the parser.
    const parsed = parseDelegatedPayment(ev);
    expect(parsed).toEqual(delegatedPayment);
  });

  it('refuses a delegated broadcast job (targeted-only)', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, delegatedPayment } = await delegatedFixture();

    await expect(
      svc.submitJobRequest(customer, {
        input: 'do the work',
        capability: 'text-gen',
        delegatedPayment,
      }),
    ).rejects.toThrow(/providerPubkey/);
    expect(pool.published).toHaveLength(0);
  });

  it('refuses malformed delegatedPayment fields at submit', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, provider, delegatedPayment } = await delegatedFixture();
    const base = {
      input: 'x',
      capability: 'text-gen',
      providerPubkey: provider.publicKey,
    };
    await expect(
      svc.submitJobRequest(customer, {
        ...base,
        delegatedPayment: { ...delegatedPayment, owner: 'not-base58-0OIl' },
      }),
    ).rejects.toThrow(/owner/);
    await expect(
      svc.submitJobRequest(customer, {
        ...base,
        delegatedPayment: { ...delegatedPayment, nonce: 'short' },
      }),
    ).rejects.toThrow(/nonce/);
    await expect(
      svc.submitJobRequest(customer, {
        ...base,
        delegatedPayment: { ...delegatedPayment, expiryUnix: -5 },
      }),
    ).rejects.toThrow(/expiryUnix/);
    await expect(
      svc.submitJobRequest(customer, {
        ...base,
        delegatedPayment: { ...delegatedPayment, proof: 'garbage' },
      }),
    ).rejects.toThrow(/proof/);
  });

  it('refuses a proof whose expiry is beyond the TTL horizon', async () => {
    // A well-formed, correctly-signed proof - only the deadline is wrong. The
    // provider refuses this too (before it burns the nonce), so nothing was
    // ever spendable; the point is that the SDK, which DECLARES the bound in
    // `SubmitJobOptions`, no longer publishes to a relay before finding out.
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, provider, delegatedPayment } = await delegatedFixture();
    await expect(
      svc.submitJobRequest(customer, {
        input: 'x',
        capability: 'text-gen',
        providerPubkey: provider.publicKey,
        delegatedPayment: {
          ...delegatedPayment,
          expiryUnix: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        },
      }),
    ).rejects.toThrow(/horizon/);
    expect(pool.published).toHaveLength(0);
  });

  it('accepts an expiry at the horizon, skew included', async () => {
    // The boundary on the ALLOWED side: the SDK grants the same skew the
    // provider does, so a caller whose clock runs fast is not refused by its
    // own SDK for a proof the provider would have taken.
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, provider, delegatedPayment } = await delegatedFixture();
    await svc.submitJobRequest(customer, {
      input: 'x',
      capability: 'text-gen',
      providerPubkey: provider.publicKey,
      delegatedPayment: {
        ...delegatedPayment,
        expiryUnix: Math.floor(Date.now() / 1000) + MAX_PROOF_TTL_SECS + PROOF_CLOCK_SKEW_SECS,
      },
    });
    expect(pool.published).toHaveLength(1);
  });

  it('refuses an already-expired proof instead of publishing a doomed job', async () => {
    const pool = createMockPool();
    const svc = new MarketplaceService(pool as any);
    const { customer, provider, delegatedPayment } = await delegatedFixture();
    await expect(
      svc.submitJobRequest(customer, {
        input: 'x',
        capability: 'text-gen',
        providerPubkey: provider.publicKey,
        delegatedPayment: {
          ...delegatedPayment,
          expiryUnix: Math.floor(Date.now() / 1000) - 1,
        },
      }),
    ).rejects.toThrow(/past/);
    expect(pool.published).toHaveLength(0);
  });
});

describe('parseDelegatedPayment', () => {
  function signedEvent(tags: string[][]): Event {
    const identity = ElisymIdentity.generate();
    return finalizeEvent(
      { kind: 5100, created_at: Math.floor(Date.now() / 1000), tags, content: 'x' },
      identity.secretKey,
    );
  }

  it('returns null for a non-delegated event', async () => {
    expect(parseDelegatedPayment(signedEvent([['t', 'elisym']]))).toBeNull();
    expect(parseDelegatedPayment(signedEvent([['payment', 'paid']]))).toBeNull();
  });

  it('throws on duplicate payment/delegation tags (injection hard-reject)', async () => {
    const { delegatedPayment } = await delegatedFixture();
    const goodTags = [
      ['payment', 'delegated'],
      ['delegation_owner', delegatedPayment.owner],
      ['delegation_expiry', String(delegatedPayment.expiryUnix)],
      ['delegation_nonce', delegatedPayment.nonce],
      ['delegation_proof', delegatedPayment.proof],
    ];
    expect(() =>
      parseDelegatedPayment(signedEvent([...goodTags, ['payment', 'delegated']])),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseDelegatedPayment(
        signedEvent([...goodTags, ['delegation_owner', delegatedPayment.owner]]),
      ),
    ).toThrow(/Duplicate/);
  });

  it('throws on a missing companion tag', async () => {
    const { delegatedPayment } = await delegatedFixture();
    expect(() =>
      parseDelegatedPayment(
        signedEvent([
          ['payment', 'delegated'],
          ['delegation_owner', delegatedPayment.owner],
          ['delegation_expiry', String(delegatedPayment.expiryUnix)],
          ['delegation_nonce', delegatedPayment.nonce],
        ]),
      ),
    ).toThrow(/missing/);
  });

  it('throws on strict-format violations', async () => {
    const { delegatedPayment } = await delegatedFixture();
    const tagsWith = (name: string, value: string) =>
      [
        ['payment', 'delegated'],
        ['delegation_owner', delegatedPayment.owner],
        ['delegation_expiry', String(delegatedPayment.expiryUnix)],
        ['delegation_nonce', delegatedPayment.nonce],
        ['delegation_proof', delegatedPayment.proof],
      ].map((tag) => (tag[0] === name ? [name, value] : tag));

    expect(() =>
      parseDelegatedPayment(signedEvent(tagsWith('delegation_owner', 'not-base58-0OIl'))),
    ).toThrow(/owner/);
    expect(() => parseDelegatedPayment(signedEvent(tagsWith('delegation_expiry', '12.5')))).toThrow(
      /expiry/,
    );
    expect(() =>
      parseDelegatedPayment(signedEvent(tagsWith('delegation_expiry', '999999999999999'))),
    ).toThrow(/expiry/);
    expect(() =>
      parseDelegatedPayment(signedEvent(tagsWith('delegation_nonce', 'tooshort'))),
    ).toThrow(/nonce/);
    expect(() =>
      parseDelegatedPayment(signedEvent(tagsWith('delegation_proof', 'garbage'))),
    ).toThrow(/proof/);
  });
});
