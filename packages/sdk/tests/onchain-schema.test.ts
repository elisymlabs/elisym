import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import { KIND_APP_HANDLER, KIND_JOB_REQUEST } from '../src/constants';
import {
  MAX_CALL_BASE64_CHARS,
  parseOnchainCallEnvelope,
  parseOnchainDescriptor,
  validateSkillOnchain,
  type OnchainDescriptor,
} from '../src/onchain';
import { ElisymIdentity } from '../src/primitives/identity';
import { DiscoveryService, parseCapabilityEvent, toDTag } from '../src/services/discovery';
import { MarketplaceService } from '../src/services/marketplace';
import type { NostrPool } from '../src/transport/pool';
import type { CapabilityCard, SubCloser } from '../src/types';

const KAMINO = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CUSTOMER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function validDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'devnet',
    kind: 'withdraw',
    programs: [KAMINO, TOKEN_PROGRAM],
    token: 'usdc',
    mint: USDC_MINT,
    decimals: 6,
    symbol: 'USDC',
    max_per_call_subunits: '500000000',
    grants_authority: false,
    max_authority_subunits: '0',
    requires: [],
    params: [{ name: 'amount', type: 'amount', required: true }],
    ...overrides,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elisym_call: 'v1',
    network: 'devnet',
    transaction: 'AQIDBAU=',
    signer: CUSTOMER,
    expires_at: 1_757_193_600,
    ...overrides,
  };
}

// --- card descriptor (read side: coerce, never throw) ---

describe('parseOnchainDescriptor', () => {
  it('accepts a valid descriptor and strips unknown keys', () => {
    const parsed = parseOnchainDescriptor(validDescriptor({ future_field: 'ignored' }));
    expect(parsed?.kind).toBe('withdraw');
    expect(parsed?.programs).toEqual([KAMINO, TOKEN_PROGRAM]);
    expect(parsed?.max_per_call_subunits).toBe('500000000');
    expect((parsed as Record<string, unknown> | null)?.future_field).toBeUndefined();
  });

  it('defaults the optional display hints', () => {
    const descriptor = validDescriptor();
    delete descriptor.requires;
    delete descriptor.params;
    const parsed = parseOnchainDescriptor(descriptor);
    expect(parsed?.requires).toEqual([]);
    expect(parsed?.params).toEqual([]);
  });

  it('accepts a zero spend ceiling - a call that moves no value is legitimate', () => {
    expect(parseOnchainDescriptor(validDescriptor({ max_per_call_subunits: '0' }))).not.toBeNull();
  });

  it('keeps an unknown param type so a future type does not lose the descriptor', () => {
    const parsed = parseOnchainDescriptor(
      validDescriptor({ params: [{ name: 'slot', type: 'future-type', required: false }] }),
    );
    expect(parsed?.params[0]?.type).toBe('future-type');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'withdraw'],
    ['an empty program allowlist', validDescriptor({ programs: [] })],
    ['a non-base58 program', validDescriptor({ programs: ['not-base58-0OIl'] })],
    // LENGTH-VALID, so only the character class can reject it. The short decoy
    // above fails on length first, leaving the alphabet rule unexercised - the
    // two together cover both halves of the pattern.
    [
      'a program with a base58-forbidden character',
      validDescriptor({ programs: [`${'K'.repeat(43)}0`] }),
    ],
    ['too many programs', validDescriptor({ programs: new Array(49).fill(KAMINO) })],
    ['an unknown network', validDescriptor({ network: 'testnet' })],
    ['an uppercase token id', validDescriptor({ token: 'USDC' })],
    ['decimals out of range', validDescriptor({ decimals: 19 })],
    ['a fractional ceiling', validDescriptor({ max_per_call_subunits: '1.5' })],
    ['a ceiling above u64', validDescriptor({ max_per_call_subunits: '18446744073709551616' })],
    ['a kind with spaces', validDescriptor({ kind: 'with draw' })],
    [
      'too many params',
      validDescriptor({ params: new Array(9).fill({ name: 'a', type: 'text' }) }),
    ],
  ])('returns null for %s', (_label, raw) => {
    expect(parseOnchainDescriptor(raw)).toBeNull();
  });

  it('rejects a non-native asset with no mint - the verifier could not bound it', () => {
    const descriptor = validDescriptor();
    delete descriptor.mint;
    expect(parseOnchainDescriptor(descriptor)).toBeNull();
  });

  it('rejects native SOL carrying a mint', () => {
    expect(
      parseOnchainDescriptor(validDescriptor({ token: 'sol', decimals: 9, symbol: 'SOL' })),
    ).toBeNull();
  });

  it('accepts native SOL without a mint', () => {
    const descriptor = validDescriptor({ token: 'sol', decimals: 9, symbol: 'SOL' });
    delete descriptor.mint;
    expect(parseOnchainDescriptor(descriptor)).not.toBeNull();
  });

  it('rejects an authority ceiling that disagrees with the flag, in both directions', () => {
    expect(
      parseOnchainDescriptor(
        validDescriptor({ grants_authority: true, max_authority_subunits: '0' }),
      ),
    ).toBeNull();
    expect(
      parseOnchainDescriptor(
        validDescriptor({ grants_authority: false, max_authority_subunits: '500000000' }),
      ),
    ).toBeNull();
  });

  it('accepts an approve-shaped descriptor when flag and ceiling agree', () => {
    const parsed = parseOnchainDescriptor(
      validDescriptor({
        kind: 'approve',
        grants_authority: true,
        max_authority_subunits: '500000000',
      }),
    );
    expect(parsed?.grants_authority).toBe(true);
    expect(parsed?.max_authority_subunits).toBe('500000000');
  });
});

// --- SKILL.md block (write side: fail loud) ---

describe('reportCallSignature tags', () => {
  it('publishes a call signature under `call_tx`, never under `tx`', async () => {
    // The tag is a protocol contract in two directions: `tx` is defined as a
    // PAYMENT reference anchored by a memo, so an indexer would count a call
    // signature as a payment; and the browser's double-execution recovery reads
    // `call_tx` back to learn a job was already signed. Only the reading half
    // was pinned, so the two could drift with nothing failing.
    const published: { tags: string[][] }[] = [];
    const identity = { secretKey: generateSecretKey() };
    const marketplace = new MarketplaceService({
      publishAll: async (event: { tags: string[][] }) => {
        published.push(event);
      },
    } as never);
    await marketplace.reportCallSignature(
      identity as never,
      'a'.repeat(64),
      'b'.repeat(64),
      'sig-1',
      { capability: 'withdraw', network: 'devnet' },
    );
    const tags = published[0]?.tags ?? [];
    expect(tags).toContainEqual(['call_tx', 'sig-1', 'solana']);
    expect(tags.some((tag) => tag[0] === 'tx')).toBe(false);
    expect(tags.some((tag) => tag[0] === 'rating')).toBe(false);
  });
});

describe('validateSkillOnchain', () => {
  const block = {
    kind: 'withdraw',
    programs: [KAMINO],
    token: 'usdc',
    mint: USDC_MINT,
    max_per_call: '500',
  };

  it('refuses an approval ceiling on a native SOL card too, on the READ side', () => {
    // The twin of the rule below, and the only thing rejecting the shape when a
    // card is parsed rather than loaded. `assertCeilings` would refuse every
    // grant on such a card anyway, but a promise that can never be kept should
    // not survive as far as a customer reading the card.
    expect(
      parseOnchainDescriptor({
        kind: 'withdraw',
        network: 'devnet',
        programs: [KAMINO],
        requires: [],
        params: [],
        token: 'sol',
        decimals: 9,
        symbol: 'SOL',
        max_per_call_subunits: '500000000',
        grants_authority: true,
        max_authority_subunits: '5000000000',
      }),
    ).toBeNull();
  });

  it('refuses an approval ceiling on a native SOL capability', () => {
    // An approval is always over an SPL mint, so a native capability could
    // never keep that promise. This rule is the only thing rejecting the shape
    // on the skill side, and its twin on the card is the only one on that side.
    expect(() =>
      validateSkillOnchain('withdraw', {
        ...block,
        token: 'sol',
        mint: undefined,
        grants_authority: true,
        max_authority: '5',
      }),
    ).toThrow('grants_authority');
  });

  it('refuses a mint alongside token: sol, which would re-denominate the ceiling', () => {
    // The loader resolves `token: 'sol'` to native SOL and discards the mint,
    // so the descriptor rule that forbids this pairing never fires. Left
    // unchecked, a block an operator wrote as 500 USDC publishes a ceiling of
    // 500 SOL - the same number re-read at 9 decimals instead of 6.
    expect(() => validateSkillOnchain('withdraw', { ...block, token: 'sol' })).toThrow(
      'onchain.mint must be absent',
    );
    // The same block without the mint is fine.
    expect(
      validateSkillOnchain('withdraw', { ...block, token: 'sol', mint: undefined })?.token,
    ).toBe('sol');
  });

  it('returns undefined when the block is absent', () => {
    expect(validateSkillOnchain('withdraw', undefined)).toBeUndefined();
    expect(validateSkillOnchain('withdraw', null)).toBeUndefined();
  });

  it('accepts a minimal block and fills the defaults', () => {
    const parsed = validateSkillOnchain('withdraw', block);
    expect(parsed?.max_per_call).toBe('500');
    expect(parsed?.grants_authority).toBe(false);
    expect(parsed?.max_authority).toBe('0');
    expect(parsed?.requires).toEqual([]);
    expect(parsed?.params).toEqual([]);
  });

  it('accepts a decimal display amount', () => {
    expect(validateSkillOnchain('withdraw', { ...block, max_per_call: '0.25' })?.max_per_call).toBe(
      '0.25',
    );
  });

  it('carries no network - it is stamped from the agent wallet at publish time', () => {
    const parsed = validateSkillOnchain('withdraw', { ...block, network: 'mainnet' });
    expect((parsed as Record<string, unknown> | undefined)?.network).toBeUndefined();
  });

  it('throws on a non-mapping block', () => {
    expect(() => validateSkillOnchain('withdraw', ['a'])).toThrow('must be a mapping');
    expect(() => validateSkillOnchain('withdraw', 'withdraw')).toThrow('must be a mapping');
  });

  it('throws on a malformed block instead of silently dropping it', () => {
    // Matched on what the operator actually reads. `'onchain'` alone was a
    // constant prefix every message in this function carries, so it could not
    // tell one failure from another - or from a message about a different rule.
    expect(() => validateSkillOnchain('withdraw', { ...block, programs: [] })).toThrow(
      /invalid "onchain" block: Array must contain at least 1 element/,
    );
    expect(() => validateSkillOnchain('withdraw', { ...block, max_per_call: 'lots' })).toThrow(
      /invalid "onchain" block/,
    );
  });

  it('throws when the authority flag and ceiling disagree', () => {
    expect(() => validateSkillOnchain('approve', { ...block, grants_authority: true })).toThrow(
      'max_authority must be positive',
    );
    expect(() => validateSkillOnchain('approve', { ...block, max_authority: '10' })).toThrow(
      'must be "0" unless',
    );
  });
});

// --- call envelope ---

describe('parseOnchainCallEnvelope', () => {
  it('accepts an object and the JSON text a skill returns', () => {
    expect(parseOnchainCallEnvelope(validEnvelope())?.signer).toBe(CUSTOMER);
    expect(parseOnchainCallEnvelope(JSON.stringify(validEnvelope()))?.signer).toBe(CUSTOMER);
  });

  it('strips unknown keys and keeps the envelope', () => {
    const parsed = parseOnchainCallEnvelope(validEnvelope({ instructions: [{}] }));
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown> | null)?.instructions).toBeUndefined();
  });

  it('keeps bounded explain entries as untrusted display text', () => {
    const parsed = parseOnchainCallEnvelope(
      validEnvelope({ explain: [{ kind: 'transfer', asset: 'usdc', amount: '120' }] }),
    );
    expect(parsed?.explain?.[0]?.kind).toBe('transfer');
  });

  it.each([
    ['unparseable JSON text', '{not json'],
    ['a future version', validEnvelope({ elisym_call: 'v2' })],
    ['a missing transaction', validEnvelope({ transaction: '' })],
    ['non-base64 transaction bytes', validEnvelope({ transaction: 'not base64!' })],
    [
      'a transaction over the wire limit',
      validEnvelope({ transaction: 'A'.repeat(MAX_CALL_BASE64_CHARS + 1) }),
    ],
    ['a non-base58 signer', validEnvelope({ signer: 'not-base58-0OIl' })],
    ['a signer with a base58-forbidden character', validEnvelope({ signer: `${'K'.repeat(43)}O` })],
    ['a zero expiry', validEnvelope({ expires_at: 0 })],
    ['a negative expiry', validEnvelope({ expires_at: -1 })],
    ['an expiry beyond the year bound', validEnvelope({ expires_at: 100_000_000_001 })],
    [
      'too many explain entries',
      validEnvelope({ explain: new Array(9).fill({ kind: 'transfer' }) }),
    ],
  ])('returns null for %s', (_label, raw) => {
    expect(parseOnchainCallEnvelope(raw)).toBeNull();
  });

  it('accepts a transaction exactly at the wire limit', () => {
    const atLimit = `${'A'.repeat(MAX_CALL_BASE64_CHARS - 1)}=`;
    expect(parseOnchainCallEnvelope(validEnvelope({ transaction: atLimit }))).not.toBeNull();
  });
});

// --- capability card integration ---

/** A descriptor that is valid on its own terms, so only the field under test differs. */
function makeDescriptor(overrides: Partial<OnchainDescriptor> = {}): OnchainDescriptor {
  return {
    network: 'devnet',
    kind: 'withdraw',
    programs: [TOKEN_PROGRAM],
    requires: [],
    params: [],
    token: 'usdc',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    decimals: 6,
    symbol: 'USDC',
    max_per_call_subunits: '500000000',
    grants_authority: false,
    max_authority_subunits: '0',
    ...overrides,
  };
}

function makeCard(overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    name: 'test-agent',
    description: 'A test agent',
    capabilities: ['onchain-call'],
    payment: { chain: 'solana', network: 'devnet', address: '11111111111111111111111111111111' },
    ...overrides,
  };
}

function makeCapabilityEvent(identity: ElisymIdentity, card: CapabilityCard): Event {
  return finalizeEvent(
    {
      kind: KIND_APP_HANDLER,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', toDTag(card.name)],
        ['t', 'elisym'],
        ['n', 'devnet'],
        ...card.capabilities.map((capability) => ['t', capability]),
        ['k', String(KIND_JOB_REQUEST)],
      ],
      content: JSON.stringify(card),
    },
    identity.secretKey,
  );
}

function createMockPool(): NostrPool & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    querySync: vi.fn().mockResolvedValue([]),
    queryBatched: vi.fn().mockResolvedValue([]),
    queryBatchedByTag: vi.fn().mockResolvedValue([]),
    queryByIds: vi.fn().mockResolvedValue([]),
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
  } as unknown as NostrPool & { published: Event[] };
}

describe('capability card - onchain descriptor', () => {
  it('survives a publish and parse round-trip', async () => {
    const identity = ElisymIdentity.generate();
    const descriptor = parseOnchainDescriptor(validDescriptor()) as OnchainDescriptor;
    const pool = createMockPool();
    const service = new DiscoveryService(pool);

    await service.publishCapability(identity, makeCard({ onchain: descriptor }));
    const published = pool.published[0];
    expect(published).toBeDefined();

    const parsed = parseCapabilityEvent(published as Event, 'devnet');
    expect(parsed?.cards[0]?.onchain?.programs).toEqual([KAMINO, TOKEN_PROGRAM]);
    expect(parsed?.cards[0]?.onchain?.max_per_call_subunits).toBe('500000000');
  });

  it('clears a malformed descriptor but keeps the card discoverable', () => {
    const identity = ElisymIdentity.generate();
    const event = makeCapabilityEvent(
      identity,
      makeCard({ onchain: { kind: 'withdraw', programs: [] } as unknown as OnchainDescriptor }),
    );
    const parsed = parseCapabilityEvent(event, 'devnet');
    expect(parsed).not.toBeNull();
    expect(parsed?.cards[0]?.onchain).toBeUndefined();
    expect(parsed?.cards[0]?.name).toBe('test-agent');
  });

  it('refuses to publish a malformed descriptor - the operator hears about it', async () => {
    const identity = ElisymIdentity.generate();
    const service = new DiscoveryService(createMockPool());
    await expect(
      service.publishCapability(
        identity,
        makeCard({ onchain: { kind: 'withdraw', programs: [] } as unknown as OnchainDescriptor }),
      ),
    ).rejects.toThrow('onchain descriptor is malformed');
  });

  it('clears a descriptor whose network disagrees with the card it rides on', () => {
    // Incoherent, and dangerous rather than merely odd: a client would check a
    // call against ceilings resolved for the other network's mints.
    const identity = ElisymIdentity.generate();
    const event = makeCapabilityEvent(
      identity,
      makeCard({ onchain: makeDescriptor({ network: 'mainnet' }) }),
    );
    const parsed = parseCapabilityEvent(event, 'devnet');
    expect(parsed).not.toBeNull();
    expect(parsed?.cards[0]?.onchain).toBeUndefined();
  });

  it('refuses to publish a descriptor for a chain the card does not pay on', async () => {
    const identity = ElisymIdentity.generate();
    const service = new DiscoveryService(createMockPool());
    await expect(
      service.publishCapability(
        identity,
        makeCard({ onchain: makeDescriptor({ network: 'mainnet' }) }),
      ),
    ).rejects.toThrow('but the card pays on devnet');
  });
});
