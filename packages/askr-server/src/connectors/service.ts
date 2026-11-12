import type { StoreConfig, SyncRelayClient } from '@elisym/askr';
import { SYNC_HOLD_SECS, SYNC_RENEW_MS } from '../constants';
import { randomId } from '../state/pg-state';
import type { ConnectorRecord, ScheduledConnector, StoreDirectory } from '../state/stores';
import type { StoreRecord } from '../state/types';
import { PREVIEW_DEADLINE_MS } from './constants';
import type { FetchGuardDeps } from './fetch-guard';
import type { ShopRateLimiter } from './http';
import { type ConnectorSyncResult, syncConnector } from './runner';
import { ConnectorScheduler, type SchedulerTimers } from './scheduler';

export interface ConnectorServiceDeps {
  directory: StoreDirectory;
  /** This instance's lease holder: only the stores it leases are synced here. */
  holder: string;
  client: SyncRelayClient;
  /** The store's current config (30496), as the worker's catalog cache reads it. */
  configFor: (owner: string) => StoreConfig | undefined;
  /**
   * The store's config read from the relay, when the cache does not have it:
   * the instance an admin call reaches may not lease the store (7.3).
   */
  readConfig?: (owner: string) => Promise<StoreConfig | undefined>;
  /** One per process, so the per-shop limit holds across stores (7.4). */
  limiter: ShopRateLimiter;
  fetch?: FetchGuardDeps;
  timers?: SchedulerTimers;
  now?: () => number;
  pace?: number;
  /** Wall-clock limit on one sync's shop reads (default `SYNC_DEADLINE_MS`). */
  syncDeadlineMs?: number;
  /** ...and on a preview's, which runs inside an admin request (default `PREVIEW_DEADLINE_MS`). */
  previewDeadlineMs?: number;
  log?: (message: string) => void;
}

/** `{origin}{path}` without a trailing slash, query or fragment: how a shop URL compares. */
function shopIdentity(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return undefined;
  }
}

/** Why the store's config does not let this connector sync, or undefined when it does (1.4). */
function configRefusal(
  config: StoreConfig | undefined,
  store: StoreRecord,
  connector: ConnectorRecord,
): string | undefined {
  if (config === undefined) {
    return 'The store config is not loaded yet';
  }
  if (config.source.kind !== 'connector' || config.source.platform !== connector.platform) {
    return `The store config does not name the ${connector.platform} connector as its product source`;
  }
  if (config.catalogKey !== store.catalogKey) {
    return "The store config does not name the server's catalog key";
  }
  // The widget adds to the cart of the shop the config names (6, 7.4): it must be this one.
  const shopUrl = config.source.shopUrl;
  if (connector.platform !== 'google' && shopUrl === undefined) {
    return 'The store config does not name the shop URL: sign the config again with the shop URL';
  }
  if (shopUrl !== undefined && shopIdentity(shopUrl) !== shopIdentity(connector.url)) {
    return 'The store config names another shop URL than the connector';
  }
  return undefined;
}

/**
 * The connectors runner (7.4, 9): a sync of one store's connector on demand
 * (the admin's first-import preview) and on the tier's interval once the
 * merchant enabled it, only for active stores (K19), with the store's
 * config origins for verification and the tier's product cap.
 */
export class ConnectorService {
  private readonly scheduler: ConnectorScheduler<ScheduledConnector>;

  constructor(private readonly deps: ConnectorServiceDeps) {
    this.scheduler = new ConnectorScheduler<ScheduledConnector>({
      loadStores: () =>
        deps.directory.scheduledConnectors(
          deps.holder,
          Math.floor((deps.now?.() ?? Date.now()) / 1000),
        ),
      sync: (connector) => this.syncScheduled(connector),
      saveStatus: (connector, result, at, nextRunAt) =>
        deps.directory.saveConnectorStatus(connector.owner, result, at, nextRunAt),
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      onError: (error) =>
        deps.log?.(`connector sync failed: ${error instanceof Error ? error.message : 'unknown'}`),
    });
  }

  /** One sync of a store's connector; a dry run returns the preview without publishing. */
  async sync(
    store: StoreRecord,
    connector: ConnectorRecord,
    options: { dryRun: boolean; maxProducts: number },
  ): Promise<ConnectorSyncResult> {
    if (store.status !== 'active') {
      return { status: 'error', message: 'The store is not active' };
    }
    const config = this.deps.configFor(store.owner) ?? (await this.deps.readConfig?.(store.owner));
    const refusal = configRefusal(config, store, connector);
    if (refusal !== undefined || config === undefined) {
      return { status: 'error', message: refusal ?? 'The store config is not loaded yet' };
    }
    return syncConnector({
      platform: connector.platform,
      url: connector.url,
      owner: store.owner,
      serverKey: store.catalogSecretKey,
      client: this.deps.client,
      origins: config.origins,
      linkOrigins: config.linkOrigins,
      limiter: this.deps.limiter,
      maxItems: options.maxProducts,
      importPolicies: connector.importPolicies,
      ...(connector.currency === undefined ? {} : { currency: connector.currency }),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.pace === undefined ? {} : { pace: this.deps.pace }),
      ...this.deadline(options.dryRun),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
  }

  private deadline(dryRun: boolean): { deadlineMs?: number } {
    if (dryRun) {
      return { deadlineMs: this.deps.previewDeadlineMs ?? PREVIEW_DEADLINE_MS };
    }
    return this.deps.syncDeadlineMs === undefined ? {} : { deadlineMs: this.deps.syncDeadlineMs };
  }

  private async syncScheduled(connector: ScheduledConnector): Promise<ConnectorSyncResult> {
    const store = await this.deps.directory.store(connector.owner);
    if (store === undefined) {
      return { status: 'error', message: 'The store is gone' };
    }
    // The store's catalog sync guard (7.3): never alongside an admin catalog sync or preview.
    const holder = randomId();
    const nowSecs = () => Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
    if (
      !(await this.deps.directory.claimCatalogSync(store.owner, holder, nowSecs(), SYNC_HOLD_SECS))
    ) {
      return { status: 'error', message: 'Another catalog sync of this store is running' };
    }
    const renewal = setInterval(() => {
      this.deps.directory
        .renewCatalogSync(store.owner, holder, nowSecs(), SYNC_HOLD_SECS)
        .catch((error: unknown) =>
          this.deps.log?.(
            `connector sync guard renewal failed: ${error instanceof Error ? error.message : 'unknown'}`,
          ),
        );
    }, SYNC_RENEW_MS);
    try {
      return await this.sync(store, connector, {
        dryRun: false,
        maxProducts: connector.maxProducts,
      });
    } finally {
      clearInterval(renewal);
      await this.deps.directory.releaseCatalogSync(store.owner, holder);
    }
  }

  start(): Promise<void> {
    return this.scheduler.start();
  }

  /** Re-read the enabled connectors (a store or connector changed). */
  refresh(): Promise<void> {
    return this.scheduler.refresh();
  }

  runNow(owner: string): void {
    this.scheduler.runNow(owner);
  }

  stop(): void {
    this.scheduler.stop();
  }
}
