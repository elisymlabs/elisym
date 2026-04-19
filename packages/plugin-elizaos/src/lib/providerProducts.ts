import type { Character } from '@elizaos/core';
import type { ElisymConfig, ProviderProduct } from '../environment';

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

export function resolveProducts(
  config: ElisymConfig,
  character: Character | undefined,
): ProviderProduct[] {
  if (config.providerProducts && config.providerProducts.length > 0) {
    return config.providerProducts;
  }
  if (
    config.providerCapabilities &&
    config.providerCapabilities.length > 0 &&
    config.providerPriceLamports !== undefined
  ) {
    const meta = resolveAgentMeta(character);
    return [
      {
        name: config.providerName ?? meta.name,
        description: config.providerDescription ?? meta.about,
        capabilities: [...config.providerCapabilities],
        priceLamports: config.providerPriceLamports,
      },
    ];
  }
  return [];
}

export function findProductByCapability(
  products: ProviderProduct[],
  capability: string,
): ProviderProduct | undefined {
  return products.find((product) => product.capabilities.includes(capability));
}
