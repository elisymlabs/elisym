import { NATIVE_SOL, resolveUsdcAsset } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { buildCapabilityCard } from '../src/commands/start';
import type { Skill } from '../src/skill';

const DELEGATE_PUBKEY = 'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE';
const WALLET_ADDRESS = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';

function skillFixture(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'code-review',
    description: 'Reviews a diff',
    capabilities: ['code-review'],
    priceSubunits: 1_000_000,
    asset: NATIVE_SOL,
    mode: 'llm',
    async execute() {
      throw new Error('card tests never execute skills');
    },
    ...overrides,
  };
}

describe('buildCapabilityCard delegation descriptor (G11)', () => {
  const delegation = {
    mechanism: 'spl-approve' as const,
    suggested_cap_subunits: '50000000',
  };

  it('keeps the delegation descriptor on a MAINNET card (the removed guard used to strip it)', () => {
    const card = buildCapabilityCard(
      skillFixture({ delegation, asset: resolveUsdcAsset('mainnet') }),
      {
        walletNetwork: 'mainnet',
        solanaAddress: WALLET_ADDRESS,
        delegatePubkey: DELEGATE_PUBKEY,
      },
    );
    expect(card.delegation).toEqual({ ...delegation, delegate_pubkey: DELEGATE_PUBKEY });
    expect(card.payment?.network).toBe('mainnet');
    expect(card.payment?.mint).toBe(resolveUsdcAsset('mainnet').mint);
  });

  it('keeps the delegation descriptor on a devnet card (parity)', () => {
    const card = buildCapabilityCard(
      skillFixture({ delegation, asset: resolveUsdcAsset('devnet') }),
      {
        walletNetwork: 'devnet',
        solanaAddress: WALLET_ADDRESS,
        delegatePubkey: DELEGATE_PUBKEY,
      },
    );
    expect(card.delegation).toEqual({ ...delegation, delegate_pubkey: DELEGATE_PUBKEY });
    expect(card.payment?.network).toBe('devnet');
  });

  it('omits the descriptor when no delegate key resolved, regardless of network', () => {
    const card = buildCapabilityCard(skillFixture({ delegation }), {
      walletNetwork: 'mainnet',
      solanaAddress: WALLET_ADDRESS,
      delegatePubkey: undefined,
    });
    expect(card.delegation).toBeUndefined();
  });

  it('omits the descriptor when the skill does not declare delegation', () => {
    const card = buildCapabilityCard(skillFixture(), {
      walletNetwork: 'mainnet',
      solanaAddress: WALLET_ADDRESS,
      delegatePubkey: DELEGATE_PUBKEY,
    });
    expect(card.delegation).toBeUndefined();
  });
});
