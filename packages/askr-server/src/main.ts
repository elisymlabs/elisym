import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ASKR_RELAYS, type StoreConfig } from '@elisym/askr';
import {
  type LlmProvider,
  type ModelPrice,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
} from '@elisym/askr-agent';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { DEFAULT_TURN_RESERVE_USD, positiveUsd } from './config';
import { createGateway } from './gateway/gateway';
import { serveGateway } from './gateway/http';
import { parseStoreRegistry } from './registry';
import { createServerPool } from './relay/pool';
import { MemoryState } from './state/memory';
import { isListed } from './worker/catalog';
import { Worker } from './worker/worker';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function providerFromEnv(): LlmProvider {
  const openRouterModel = process.env.ASKR_OPENROUTER_MODEL;
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
    model: required('ASKR_MODEL'),
  });
}

function priceFromEnv(): ModelPrice {
  return {
    input: positiveUsd('ASKR_PRICE_INPUT', required('ASKR_PRICE_INPUT')),
    cachedInput: positiveUsd('ASKR_PRICE_CACHED_INPUT', required('ASKR_PRICE_CACHED_INPUT')),
    cacheWrite: positiveUsd('ASKR_PRICE_CACHE_WRITE', required('ASKR_PRICE_CACHE_WRITE')),
    output: positiveUsd('ASKR_PRICE_OUTPUT', required('ASKR_PRICE_OUTPUT')),
  };
}

/** The built widget, from `ASKR_WIDGET_FILE` or the workspace's `@elisym/askr-widget`. */
function widgetScript(): string {
  const path =
    process.env.ASKR_WIDGET_FILE ??
    createRequire(import.meta.url).resolve('@elisym/askr-widget/widget.js');
  return readFileSync(path, 'utf8');
}

async function main(): Promise<void> {
  const relayUrl = process.env.ASKR_RELAY_URL ?? ASKR_RELAYS[0] ?? '';
  const gatewaySecretKey = hexToBytes(required('ASKR_GATEWAY_SECRET'));
  const state = new MemoryState(
    parseStoreRegistry(readFileSync(required('ASKR_STORES_FILE'), 'utf8')),
  );
  const provider = providerFromEnv();
  const reserveUsd = positiveUsd(
    'ASKR_TURN_RESERVE_USD',
    process.env.ASKR_TURN_RESERVE_USD ?? DEFAULT_TURN_RESERVE_USD,
  );
  let worker: Worker | undefined;
  const pool = createServerPool((pubkey) => worker?.isLeased(pubkey) ?? false);
  worker = new Worker({
    relayUrl,
    state,
    pool,
    gatewayKeys: [getPublicKey(gatewaySecretKey)],
    providerFor: () => provider,
    price: priceFromEnv(),
    reserveUsd,
    log: (message) => console.error(message),
  });
  await worker.start();
  const catalogs = worker.catalogs;
  const handler = createGateway({
    state,
    gatewaySecretKey,
    widgetScript: widgetScript(),
    configFor: (owner): StoreConfig | undefined => catalogs.get(owner)?.config,
    isListed: (owner, address) => isListed(catalogs.get(owner), address),
    isUnservable: (owner) => worker?.isUnservable(owner) ?? false,
    reserveUsd,
  });
  serveGateway(handler, {
    port: Number(process.env.PORT ?? '8787'),
    trustProxy: process.env.ASKR_TRUST_PROXY === '1',
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
