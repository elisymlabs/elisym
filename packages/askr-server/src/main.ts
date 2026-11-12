import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ASKR_API_BASE, ASKR_RELAYS, type StoreConfig } from '@elisym/askr';
import {
  type LlmProvider,
  type ModelPrice,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
} from '@elisym/askr-agent';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { createAdminApi } from './admin/api';
import { type AdminFile, createAdminPages, loadAdminFiles } from './admin/pages';
import { runCli } from './cli';
import { DEFAULT_TURN_RESERVE_USD, positiveUsd, publicBaseOf } from './config';
import { ShopRateLimiter } from './connectors/http';
import { ConnectorService } from './connectors/service';
import type { Db } from './db/db';
import { STORES_CHANNEL } from './db/db';
import { KeyVault } from './db/keys';
import { migrate } from './db/migrations';
import { createPgDb } from './db/pg';
import { type GatewayRequest, createGateway } from './gateway/gateway';
import { serveGateway } from './gateway/http';
import { StoreEventPublisher } from './publisher';
import { createServerPool } from './relay/pool';
import { poolSyncClient } from './relay/sync-client';
import { PgState } from './state/pg-state';
import { StoreDirectory } from './state/stores';
import { isListed } from './worker/catalog';
import { readStoreConfig } from './worker/config-read';
import { Worker } from './worker/worker';

const STORE_POLL_MS = 60_000;

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

/**
 * The built admin app (7.3), from `ASKR_ADMIN_DIR` or the workspace's
 * `@elisym/askr-admin`; none means the admin is not served here.
 */
function adminFiles(log: (message: string) => void): Map<string, AdminFile> | undefined {
  const configured = process.env.ASKR_ADMIN_DIR;
  if (configured !== undefined) {
    // Named on purpose: a wrong directory stops the server rather than serving no admin.
    return loadAdminFiles(configured);
  }
  try {
    const installed = createRequire(import.meta.url).resolve('@elisym/askr-admin/package.json');
    return loadAdminFiles(join(dirname(installed), 'dist'));
  } catch (error) {
    log(
      `the admin app is not installed or not built: /admin/ is not served (${error instanceof Error ? error.message : 'unknown'})`,
    );
    return undefined;
  }
}

/** The master key (9) from a Docker secret file or the environment, never from the database. */
function masterKey(): string {
  const file = process.env.ASKR_MASTER_KEY_FILE;
  return file ? readFileSync(file, 'utf8').trim() : required('ASKR_MASTER_KEY');
}

async function serve(db: Db, vault: KeyVault): Promise<void> {
  const log = (message: string) => console.error(message);
  const relayUrl = process.env.ASKR_RELAY_URL ?? ASKR_RELAYS[0] ?? '';
  const gatewaySecretKey = hexToBytes(required('ASKR_GATEWAY_SECRET'));
  const state = new PgState(db, vault, log);
  const directory = new StoreDirectory(db, vault);
  const provider = providerFromEnv();
  const reserveUsd = positiveUsd(
    'ASKR_TURN_RESERVE_USD',
    process.env.ASKR_TURN_RESERVE_USD ?? DEFAULT_TURN_RESERVE_USD,
  );
  let leasedBy: Worker | undefined;
  const pool = createServerPool((pubkey) => leasedBy?.isLeased(pubkey) ?? false);
  const worker = new Worker({
    relayUrl,
    state,
    pool,
    gatewayKeys: [getPublicKey(gatewaySecretKey)],
    providerFor: () => provider,
    price: priceFromEnv(),
    reserveUsd,
    log,
  });
  leasedBy = worker;
  const publisher = new StoreEventPublisher({ directory, pool, relayUrl, log });
  const catalogs = worker.catalogs;
  const syncClient = poolSyncClient(pool, relayUrl);
  const connectors = new ConnectorService({
    directory,
    holder: worker.holderId,
    client: syncClient,
    configFor: (owner) => catalogs.get(owner)?.config,
    readConfig: (owner) => readStoreConfig(pool, relayUrl, owner, Math.floor(Date.now() / 1000)),
    limiter: new ShopRateLimiter(),
    log,
  });

  let server: Server | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  async function stopServing(): Promise<void> {
    server?.close();
    clearInterval(pollTimer);
    connectors.stop();
    await unlisten?.().catch(() => undefined);
    // Turns in flight get a bounded wait, then the leases are given up so another instance
    // takes the stores at once (5.8).
    await worker.shutdown();
    await db.close();
  }
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopServing()
      .catch((error: unknown) =>
        log(`shutdown: ${error instanceof Error ? error.message : 'unknown'}`),
      )
      .finally(() => process.exit(0));
  };
  // Installed before anything starts, so a signal during startup still releases the leases.
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await worker.start();
  const onStoresChanged = () => {
    // Serve a newly active store first, then publish its stored events (7.3) and sync its connector.
    worker
      .refreshLeases()
      .then(() => publisher.run())
      .then(() => connectors.refresh())
      .catch((error: unknown) => {
        log(`store change handling failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
  };
  if (shuttingDown) {
    return;
  }
  unlisten = await db.listen(STORES_CHANNEL, onStoresChanged);
  if (shuttingDown) {
    return;
  }
  // The poll covers a notify missed while the listening connection was down (7.3).
  pollTimer = setInterval(onStoresChanged, STORE_POLL_MS);
  onStoresChanged();
  await connectors.start();
  if (shuttingDown) {
    connectors.stop();
    return;
  }
  const gateway = createGateway({
    state,
    gatewaySecretKey,
    widgetScript: widgetScript(),
    configFor: (owner): StoreConfig | undefined => catalogs.get(owner)?.config,
    isListed: (owner, address) => isListed(catalogs.get(owner), address),
    isUnservable: (owner) => worker.isUnservable(owner),
    reserveUsd,
  });
  const admin = createAdminApi({
    directory,
    // A trailing slash is stripped once at startup, so NIP-98 `u` compares exactly.
    publicBase: publicBaseOf(process.env.ASKR_PUBLIC_BASE ?? ASKR_API_BASE),
    syncClient,
    storeEventsChanged: onStoresChanged,
    connectors,
    log,
  });
  const files = adminFiles(log);
  const adminPages = files === undefined ? undefined : createAdminPages(files, relayUrl);
  const handler = async (input: GatewayRequest): Promise<Response> =>
    adminPages?.(input) ?? (await admin(input)) ?? gateway(input);
  server = serveGateway(handler, {
    port: Number(process.env.PORT ?? '8787'),
    trustProxy: process.env.ASKR_TRUST_PROXY === '1',
  });
}

async function main(): Promise<void> {
  const db = createPgDb(required('DATABASE_URL'));
  const vault = new KeyVault(masterKey());
  await migrate(db);
  const args = process.argv.slice(2);
  if (args.length > 0) {
    try {
      console.log(await runCli(args, new StoreDirectory(db, vault)));
    } finally {
      await db.close();
    }
    return;
  }
  await serve(db, vault);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
