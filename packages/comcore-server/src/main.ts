import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { COMCORE_RELAYS, type StoreConfig } from '@elisym/comcore';
import {
  type LlmProvider,
  type ModelPrice,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
} from '@elisym/comcore-agent';
import Decimal from 'decimal.js-light';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { createGateway } from './gateway/gateway';
import { serveGateway } from './gateway/http';
import { parseStoreRegistry } from './registry';
import { createServerPool } from './relay/pool';
import { MemoryState } from './state/memory';
import { isListed } from './worker/catalog';
import { Worker } from './worker/worker';

const USD_RE = /^\d{1,9}(\.\d{1,12})?$/;
const DEFAULT_TURN_RESERVE_USD = '0.25';

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

/** A USD amount from the environment: a plain decimal above zero, checked at start, not on the first ask. */
function positiveUsd(name: string, value: string): string {
  if (!USD_RE.test(value) || new Decimal(value).lessThanOrEqualTo(0)) {
    throw new Error(`${name} must be a decimal above zero, got ${value}`);
  }
  return value;
}

function priceFromEnv(): ModelPrice {
  return {
    input: positiveUsd('COMCORE_PRICE_INPUT', required('COMCORE_PRICE_INPUT')),
    cachedInput: positiveUsd('COMCORE_PRICE_CACHED_INPUT', required('COMCORE_PRICE_CACHED_INPUT')),
    cacheWrite: positiveUsd('COMCORE_PRICE_CACHE_WRITE', required('COMCORE_PRICE_CACHE_WRITE')),
    output: positiveUsd('COMCORE_PRICE_OUTPUT', required('COMCORE_PRICE_OUTPUT')),
  };
}

/** The built widget, from `COMCORE_WIDGET_FILE` or the workspace's `@elisym/comcore-widget`. */
function widgetScript(): string {
  const path =
    process.env.COMCORE_WIDGET_FILE ??
    createRequire(import.meta.url).resolve('@elisym/comcore-widget/widget.js');
  return readFileSync(path, 'utf8');
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
    reserveUsd: positiveUsd(
      'COMCORE_TURN_RESERVE_USD',
      process.env.COMCORE_TURN_RESERVE_USD ?? DEFAULT_TURN_RESERVE_USD,
    ),
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
