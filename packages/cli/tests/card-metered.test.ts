/**
 * Metered descriptor as STAMPED onto the capability card.
 *
 * The property that matters here: `metered` must not appear unless the card
 * also ships a usable `delegation`, because the delegated pull is the only rail
 * that can meter. The read side (clear-don't-drop) is proven in the SDK's
 * `discovery.test.ts`, where the wire-format helper lives.
 */
import { describe, expect, it } from 'vitest';
import { buildCapabilityCard } from '../src/commands/start.js';
import type { Skill } from '../src/skill';

const DELEGATION = { mechanism: 'spl-approve' as const, suggested_cap_subunits: '50000000' };
const DELEGATE = 'HWM7Pv9EokrYaPShAjMJcfMKqxUEacW7Jd7j1Mdyz2Jf';
const PROVIDER = 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'metered-skill',
    description: 'meters what it uses',
    capabilities: ['text-gen'],
    priceSubunits: 50_000,
    asset: { token: 'usdc', symbol: 'USDC', decimals: 6, mint: 'mint' },
    mode: 'dynamic-script',
    delegation: DELEGATION,
    meteredMinSubunits: 1_000n,
    ...overrides,
  } as unknown as Skill;
}

const inputs = (delegatePubkey?: string) =>
  ({
    agentName: 'a',
    agentDescription: 'd',
    solanaAddress: PROVIDER,
    walletNetwork: 'devnet' as const,
    ...(delegatePubkey ? { delegatePubkey } : {}),
  }) as never;

describe('capability card > metered descriptor', () => {
  it('publishes the floor in subunits when delegation and a delegate key are present', () => {
    const card = buildCapabilityCard(makeSkill(), inputs(DELEGATE));
    expect(card.metered).toEqual({ min_subunits: '1000' });
  });

  it('omits metered when the agent has no delegate key', () => {
    const card = buildCapabilityCard(makeSkill(), inputs(undefined));
    expect(card.metered).toBeUndefined();
  });

  it('omits metered when the agent has no payment address', () => {
    // Without `solanaAddress` the card ships no `payment` block, so a metered
    // descriptor has no ceiling to clamp against - incoherent by construction.
    // Stamping it anyway would make the write-side mirror reject the card with
    // "malformed metered descriptor" instead of the real reason.
    const card = buildCapabilityCard(makeSkill(), {
      agentName: 'a',
      agentDescription: 'd',
      walletNetwork: 'devnet' as const,
      delegatePubkey: DELEGATE,
    } as never);
    expect(card.payment).toBeUndefined();
    expect(card.metered).toBeUndefined();
  });

  it('omits metered when the skill itself declares no delegation', () => {
    // `delegatePubkey` is agent-wide, so it can be set while THIS skill ships no
    // delegation block. Advertising per-use billing on such a card would tell
    // the buyer "pay for what you use" while the only rail they can reach
    // charges the ceiling. The loader also refuses this combination - belt and
    // braces, deliberately.
    const card = buildCapabilityCard(makeSkill({ delegation: undefined }), inputs(DELEGATE));
    expect(card.metered).toBeUndefined();
  });
});
