import { describe, expect, it } from 'vitest';
import type { ElisymConfig, ProviderProduct } from '../../src/environment';
import { resolveProducts } from '../../src/lib/providerProducts';
import type { Skill } from '../../src/skills';

function fakeSkill(name: string, capabilities: string[], priceLamports: bigint): Skill {
  return {
    name,
    description: `${name} description`,
    capabilities,
    priceLamports,
    async execute() {
      return { data: '' };
    },
  };
}

function baseConfig(overrides: Partial<ElisymConfig> = {}): ElisymConfig {
  return {
    network: 'devnet',
    mode: 'provider',
    signerKind: 'local',
    maxSpendPerJobLamports: 10n,
    maxSpendPerHourLamports: 10n,
    requireApprovalAboveLamports: 1n,
    ...overrides,
  } as unknown as ElisymConfig;
}

describe('resolveProducts with skills', () => {
  it('returns skill-derived products when no explicit config is set', () => {
    const skills = [fakeSkill('yt', ['youtube-summary'], 2_000_000n)];
    const products = resolveProducts(baseConfig(), undefined, skills);
    expect(products).toEqual([
      {
        name: 'yt',
        description: 'yt description',
        capabilities: ['youtube-summary'],
        priceLamports: 2_000_000n,
      },
    ]);
  });

  it('merges explicit products with skill-derived ones on distinct names', () => {
    const explicit: ProviderProduct = {
      name: 'explicit',
      description: 'x',
      capabilities: ['a'],
      priceLamports: 1_000n,
    };
    const skills = [fakeSkill('skill-one', ['b'], 3_000n)];
    const products = resolveProducts(
      baseConfig({ providerProducts: [explicit] }),
      undefined,
      skills,
    );
    expect(products.map((product) => product.name).sort()).toEqual(['explicit', 'skill-one']);
  });

  it('explicit wins on name collision (skill-derived is dropped with a warn)', () => {
    const explicit: ProviderProduct = {
      name: 'collide',
      description: 'explicit',
      capabilities: ['a'],
      priceLamports: 1_000n,
    };
    const skills = [fakeSkill('collide', ['b'], 2_000n)];
    const products = resolveProducts(
      baseConfig({ providerProducts: [explicit] }),
      undefined,
      skills,
    );
    expect(products).toHaveLength(1);
    expect(products[0]?.description).toBe('explicit');
    expect(products[0]?.priceLamports).toBe(1_000n);
  });

  it('returns legacy single product + skills when legacy vars are set', () => {
    const config = baseConfig({
      providerCapabilities: ['legacy-cap'],
      providerPriceLamports: 500n,
      providerName: 'legacy',
    });
    const skills = [fakeSkill('yt', ['youtube-summary'], 2_000n)];
    const products = resolveProducts(config, undefined, skills);
    expect(products.map((product) => product.name).sort()).toEqual(['legacy', 'yt']);
  });
});
