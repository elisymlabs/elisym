import { readFileSync } from 'node:fs';
import { COMCORE_RELAYS, type StoreConfig } from '@elisym/comcore';
import {
  type LlmProvider,
  type ModelPrice,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
} from '@elisym/comcore-agent';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { createGateway } from './gateway/gateway';
import { serveGateway } from './gateway/http';
import { parseStoreRegistry } from './registry';
import { createServerPool } from './relay/pool';
import { MemoryState } from './state/memory';
import { Worker } from './worker/worker';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function providerFromEnv(): LlmProvider {
  const openRouterModel = process.env.COMCORE_OPENROUTER_MODEL;
  if (openRouterModel) {
    return createOpenAiCompatibleProvider({
      apiKey: required('OPENROUTER_API_KEY'),
      model: openRouterModel,
      baseUrl: 'https://openrouter.ai/api/v1',
      passCacheMarks: openRouterModel.startsWith('anthropic/'),
      // No training and zero data retention where offered (4.4).
      extraBody: { provider: { data_collection: 'deny' } },
    });
  }
  return createAnthropicProvider({
    apiKey: required('ANTHROPIC_API_KEY'),
    model: required('COMCORE_MODEL'),
  });
}

function priceFromEnv(): ModelPrice {
  return {
    input: required('COMCORE_PRICE_INPUT'),
    cachedInput: required('COMCORE_PRICE_CACHED_INPUT'),
    cacheWrite: required('COMCORE_PRICE_CACHE_WRITE'),
    output: required('COMCORE_PRICE_OUTPUT'),
  };
}

async function main(): Promise<void> {
  const relayUrl = process.env.COMCORE_RELAY_URL ?? COMCORE_RELAYS[0] ?? '';
  const gatewaySecretKey = hexToBytes(required('COMCORE_GATEWAY_SECRET'));
  const state = new MemoryState(
    parseStoreRegistry(readFileSync(required('COMCORE_STORES_FILE'), 'utf8')),
  );
  const provider = providerFromEnv();
  let worker: Worker | undefined;
  const pool = createServerPool((pubkey) => worker?.isLeased(pubkey) ?? false);
  worker = new Worker({
    relayUrl,
    state,
    pool,
    gatewayKeys: [getPublicKey(gatewaySecretKey)],
    providerFor: () => provider,
    price: priceFromEnv(),
    reserveUsd: process.env.COMCORE_RESERVE_USD ?? '0.05',
    maxTurnUsd: process.env.COMCORE_MAX_TURN_USD ?? '0.25',
    log: (message) => console.error(message),
  });
  await worker.start();
  const catalogs = worker.catalogs;
  const handler = createGateway({
    state,
    gatewaySecretKey,
    configFor: (owner): StoreConfig | undefined => catalogs.get(owner)?.config,
  });
  serveGateway(handler, {
    port: Number(process.env.PORT ?? '8787'),
    trustProxy: process.env.COMCORE_TRUST_PROXY === '1',
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
