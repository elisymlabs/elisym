import type { ConnectorPlatform, SyncDiff } from '@elisym/askr';

/** What an operator assigns a store (`packages/askr-server/src/state/types.ts`). */
export interface Tier {
  name: string;
  messagesPerSessionPerDay: number;
  /** USD, decimal string. */
  dailyBudgetUsd: string;
  /** USD, decimal string. */
  monthlyBudgetUsd: string;
  ticketsPerStorePerMinute: number;
  maxProducts: number;
  syncIntervalMinutes: number;
  branding: boolean;
}

export type StoreStatus = 'pending' | 'active' | 'suspended';

/**
 * What saving settings did to a pending store (`POST /v1/admin/store/events`):
 * activated on the auto tier, or why not (`disabled`: no auto-activation for
 * this store, so only a message to us helps).
 */
export type Activation = 'activated' | 'capacity_reached' | 'no_tier' | 'disabled';

export interface StoreUsage {
  today: { spent: string; reserved: string };
  month: { spent: string };
  /** Conversations still open. */
  sessions: number;
  /**
   * Conversations so far: visitor sessions (up to 24 hours from their first
   * message) that got at least one answer, each counted once.
   */
  conversations: number;
  /** Advisory clicks by listing address: product link opens (`count`) and add to cart presses. */
  clicks: { address: string; count: number; carts: number }[];
}

export type CatalogSyncStatus =
  | { state: 'running'; diff: SyncDiff }
  | { state: 'done'; diff: SyncDiff }
  | { state: 'failed'; diff: SyncDiff; error: string };

export interface ConnectorRecord {
  owner: string;
  platform: ConnectorPlatform;
  url: string;
  currency?: string;
  importPolicies: boolean;
  enabled: boolean;
  lastStatus: unknown;
  /** Unix ms. */
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface StoreEventStatus {
  pending: number;
  failing: { id: string; kind: number; failures: number; attempts: number; stopped: boolean }[];
}

/** `GET /v1/admin/store/events`: the O-signed events the relay does not have yet, newest first. */
export interface StoredEventsRead {
  /** As the server returns them: checked like relay data before use (`lib/stored-events.ts`). */
  events: unknown[];
  /** Older events were left out for the response's size bound. */
  truncated: boolean;
}

/** The current bundle's pinned address and SRI value, as `GET /v1/widget` gives them. */
export interface PinnedWidget {
  /** `<the API base this admin reads>/widget/<id>.js` */
  src: string;
  /** `sha384-<base64>` */
  integrity: string;
}

/** `GET /v1/admin/store` (the server's `view()`). */
export interface StoreView {
  owner: string;
  status: StoreStatus;
  tier: Tier | null;
  /** A, hex. */
  assistant: string;
  nextAssistant: string | null;
  /** The server catalog key K, hex. */
  catalogKey: string;
  usage: StoreUsage;
  catalogSync: CatalogSyncStatus | null;
  connector: ConnectorRecord | null;
  events: StoreEventStatus;
  /** The owner key this store moved from (K21), hex; its settings are signed again by the new one. */
  movedFrom: string | null;
}

/** `GET /v1/admin/store/moved-settings`: what the previous owner key signed (K21). */
export interface MovedSettings {
  /** The previous owner key, hex. */
  from: string;
  /**
   * The store's earlier key that signed `config`: `from`, or one before it when
   * `from` signed nothing. Null with no settings.
   */
  signedBy: string | null;
  /** Its newest config event, unchecked: the admin checks it like relay data. */
  config: unknown;
  /** Its private part, as the server read it with the assistant key. */
  private: unknown;
}

export interface SkippedProduct {
  sourceId: string;
  reason: string;
}

export interface VerificationFailure {
  origin: string;
  reason: 'not_configured' | 'not_found' | 'fetch_failed' | 'blocked';
}

/** A connector preview's result (`packages/askr-server/src/connectors/runner.ts`). */
export type ConnectorSyncResult =
  | {
      status: 'ok';
      diff: SyncDiff;
      truncated: string[];
      skipped: SkippedProduct[];
      policies?: { set: string[]; removed: string[]; unchanged: string[]; truncated: string[] };
      policyError?: string;
      items?: { d: string; title: string; price: { amount: string; currency: string } }[];
    }
  | { status: 'verification_failed'; failures: VerificationFailure[] }
  | { status: 'source_closed'; url: string; reason: string; httpStatus?: number }
  | {
      status: 'error';
      message: string;
      /** Set when the catalog is larger than the plan indexes: `count` products, `max` allowed. */
      reason?: 'too_many_products';
      count?: number;
      max?: number;
    };
