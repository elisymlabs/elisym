import type { ConnectorPlatform, SyncDiff } from '@elisym/askr';

/** What an operator assigns a store (`packages/askr-server/src/state/types.ts`). */
export interface Tier {
  name: string;
  messagesPerSessionPerDay: number;
  /** USD, decimal string: the plan's only spend limit. */
  monthlyBudgetUsd: string;
  ticketsPerStorePerMinute: number;
  maxProducts: number;
  syncIntervalMinutes: number;
  branding: boolean;
}

export type StoreStatus = 'pending' | 'active' | 'suspended';

/** The used-up budget that keeps the chat from answering: the plan's monthly one, the only one. */
export type BudgetPause = 'month';

/**
 * What choosing Free did (`POST /v1/admin/store/plan`, 6.1): the store is
 * active on Free now, or was active already.
 */
export type Activation = 'activated' | 'already_active';

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
  /** What the widget did each UTC day with any activity, the last 30 days, oldest first. */
  days: ActivityDay[];
}

/** One UTC day of the widget's activity (`activity_days` on the server). */
export interface ActivityDay {
  /** Days since the Unix epoch, UTC. */
  day: number;
  /** Conversations that got their first answer that day. */
  conversations: number;
  /** Questions answered. */
  answers: number;
  /** Product pages opened from the chat's cards (advisory). */
  links: number;
  /** Add to cart presses on the chat's cards (advisory). */
  carts: number;
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
  /** Where the Askr operator writes to the owner (plan, billing); private, never published. */
  email: string | null;
  /**
   * The chat does not answer: this month's plan budget is used up (`month`), by the server's own
   * test (nothing of it is left). Null while it answers.
   */
  budgetPaused: BudgetPause | null;
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
