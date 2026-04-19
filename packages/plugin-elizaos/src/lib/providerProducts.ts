import { toDTag } from '@elisym/sdk';
import type { Character } from '@elizaos/core';
import type { ElisymConfig, ProviderProduct } from '../environment';
import type { Skill } from '../skills';
import { logger } from './logger';

function flattenBio(bio: unknown): string | undefined {
  if (typeof bio === 'string') {
    return bio.trim() || undefined;
  }
  if (Array.isArray(bio)) {
    const joined = bio
      .filter((line) => typeof line === 'string')
      .join(' ')
      .trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

export interface AgentMeta {
  name: string;
  about: string;
}

export function resolveAgentMeta(character: Character | undefined): AgentMeta {
  const name = character?.name ?? 'elizaos-agent';
  const about = flattenBio(character?.bio) ?? 'ElizaOS agent on elisym';
  return { name, about };
}

export function deriveProductsFromSkills(skills: readonly Skill[]): ProviderProduct[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    capabilities: [...skill.capabilities],
    priceLamports: skill.priceLamports,
  }));
}

function mergeProducts(explicit: ProviderProduct[], derived: ProviderProduct[]): ProviderProduct[] {
  if (derived.length === 0) {
    return explicit;
  }
  const byName = new Map<string, ProviderProduct>();
  for (const product of explicit) {
    byName.set(product.name, product);
  }
  for (const product of derived) {
    if (byName.has(product.name)) {
      logger.warn(
        { name: product.name },
        'skill-derived product name collides with explicit ELISYM_PROVIDER_PRODUCTS entry; explicit wins',
      );
      continue;
    }
    byName.set(product.name, product);
  }
  return [...byName.values()];
}

export function resolveProducts(
  config: ElisymConfig,
  character: Character | undefined,
  skills: readonly Skill[] = [],
): ProviderProduct[] {
  const derived = deriveProductsFromSkills(skills);
  if (config.providerProducts && config.providerProducts.length > 0) {
    return mergeProducts(config.providerProducts, derived);
  }
  if (
    config.providerCapabilities &&
    config.providerCapabilities.length > 0 &&
    config.providerPriceLamports !== undefined
  ) {
    const meta = resolveAgentMeta(character);
    const legacy: ProviderProduct = {
      name: config.providerName ?? meta.name,
      description: config.providerDescription ?? meta.about,
      capabilities: [...config.providerCapabilities],
      priceLamports: config.providerPriceLamports,
    };
    return mergeProducts([legacy], derived);
  }
  return derived;
}

// The elisym web UI hires a product by its `d`-tag (toDTag(card.name)),
// while `elisym-cli` and MCP hire by entries in the `capabilities` array.
// Accept either so both clients route to the same product.
export function findProductByCapability(
  products: ProviderProduct[],
  capability: string,
): ProviderProduct | undefined {
  return products.find(
    (product) => product.capabilities.includes(capability) || toDTag(product.name) === capability,
  );
}
