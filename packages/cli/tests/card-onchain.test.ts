/**
 * `buildCapabilityCard` and the on-chain descriptor.
 *
 * The invariant under test is small and load-bearing: a card must never promise
 * a chain the operator did not choose. `network` is absent from SKILL.md by
 * design and stamped here from the agent's wallet, so an agent with no wallet
 * has nothing to stamp - and publishes no descriptor rather than defaulting to
 * one. `start` refuses to advertise such a capability at all.
 */
import { NATIVE_SOL, resolveUsdcAsset, type SkillOnchainResolved } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { buildCapabilityCard, withholdsOnchainCard } from '../src/commands/start';
import type { Skill } from '../src/skill';

const WALLET_ADDRESS = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const onchain: SkillOnchainResolved = {
  kind: 'withdraw',
  programs: [TOKEN_PROGRAM],
  requires: [],
  params: [],
  token: 'usdc',
  mint: USDC_MAINNET_MINT,
  decimals: 6,
  symbol: 'USDC',
  max_per_call_subunits: '500000000',
  grants_authority: false,
  max_authority_subunits: '0',
};

function skillFixture(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'kamino-withdraw',
    description: 'Builds the withdrawal call',
    capabilities: ['onchain-call'],
    priceSubunits: 1_000_000,
    asset: NATIVE_SOL,
    mode: 'onchain',
    async execute() {
      throw new Error('card tests never execute skills');
    },
    ...overrides,
  };
}

describe('buildCapabilityCard on-chain descriptor', () => {
  it('stamps the network from the agent wallet, never from SKILL.md', () => {
    const card = buildCapabilityCard(
      skillFixture({ onchain, asset: resolveUsdcAsset('mainnet') }),
      { walletNetwork: 'mainnet', solanaAddress: WALLET_ADDRESS },
    );
    expect(card.onchain).toEqual({ ...onchain, network: 'mainnet' });
    expect(card.payment?.network).toBe('mainnet');
  });

  it('stamps devnet for a devnet agent from the same skill file', () => {
    // The loader resolves the mint per network, so a devnet agent's block
    // carries the devnet mint. What is under test is that `network` follows the
    // wallet rather than anything the operator wrote.
    const card = buildCapabilityCard(
      skillFixture({
        onchain: { ...onchain, mint: USDC_DEVNET_MINT },
        asset: resolveUsdcAsset('devnet'),
      }),
      { walletNetwork: 'devnet', solanaAddress: WALLET_ADDRESS },
    );
    expect(card.onchain?.network).toBe('devnet');
    expect(card.onchain?.mint).toBe(USDC_DEVNET_MINT);
  });

  it('publishes NO descriptor when the agent has no Solana address to stamp from', () => {
    // `walletNetwork` would be a default here, not a choice. A card promising
    // the wrong chain is worse than a card promising nothing.
    const card = buildCapabilityCard(skillFixture({ onchain }), { walletNetwork: 'devnet' });
    expect(card.onchain).toBeUndefined();
  });

  it('leaves an ordinary capability without a descriptor', () => {
    const card = buildCapabilityCard(skillFixture({ mode: 'llm' }), {
      walletNetwork: 'devnet',
      solanaAddress: WALLET_ADDRESS,
    });
    expect(card.onchain).toBeUndefined();
  });
});

describe('withholdsOnchainCard', () => {
  it('refuses to advertise an on-chain capability with no wallet behind it', () => {
    // The card would carry no descriptor, so a customer could buy the job and
    // then find nothing to check the returned call against. Not selling it is
    // the kinder failure, and the one the operator can see in their own log.
    expect(withholdsOnchainCard({ onchain }, undefined)).toBe(true);
    expect(withholdsOnchainCard({ onchain }, WALLET_ADDRESS)).toBe(false);
  });

  it('leaves every other capability alone', () => {
    expect(withholdsOnchainCard({}, undefined)).toBe(false);
  });
});
