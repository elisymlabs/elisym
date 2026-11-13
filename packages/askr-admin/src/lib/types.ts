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
  /** Advisory product link clicks, by listing address. */
  clicks: { address: string; count: number }[];
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

/** `GET /v1/widget`: the current bundle's content-addressed path and its SRI value. */
export interface PinnedWidget {
  /** `/widget/<id>.js` */
  path: string;
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
}

export interface SkippedProduct {
  sourceId: string;
  reason: string;
}

export interface VerificationFailure {
  origin: string;
  reason: 'not_configured' | 'not_found' | 'fetch_failed';
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
  | { status: 'error'; message: string };
