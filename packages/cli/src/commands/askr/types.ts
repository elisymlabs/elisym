/**
 * The server's admin answers the `askr` commands read
 * (`packages/askr-server/src/admin/api.ts`), only the fields they use.
 */
import type { ConnectorPlatform, SyncDiff } from '@elisym/askr';

export interface TierView {
  name: string;
  maxProducts: number;
  branding: boolean;
}

export type StoreStatus = 'pending' | 'active' | 'suspended';

export type CatalogSyncView =
  | { state: 'running'; diff: SyncDiff }
  | { state: 'done'; diff: SyncDiff }
  | { state: 'failed'; diff: SyncDiff; error: string };

export interface ConnectorView {
  platform: ConnectorPlatform;
  url: string;
  currency?: string;
  importPolicies: boolean;
  enabled: boolean;
  /** The stored result of the last scheduled sync (`ConnectorSyncResult`), unchecked. */
  lastStatus: unknown;
  /** Unix ms. */
  lastRunAt: number | null;
}

export interface EventStatusView {
  pending: number;
  failing: { id: string; kind: number; stopped: boolean }[];
}

/** A store's paid plan as the server last heard from Stripe (absent from servers before billing). */
export interface BillingView {
  /** The server takes payments: `askr plan <paid plan>` gives a checkout link. */
  enabled: boolean;
  plan: string | null;
  interval: 'month' | 'year' | null;
  status: string | null;
  /** Unix seconds. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  manageable: boolean;
  checkoutAvailable: boolean;
  /** We set this store's plan (or it is suspended): paid plans are not bought here. */
  operatorManaged?: boolean;
}

/** `GET /v1/admin/store`. */
export interface StoreView {
  owner: string;
  status: StoreStatus;
  tier: TierView | null;
  assistant: string;
  nextAssistant: string | null;
  /** The server catalog key K, hex. */
  catalogKey: string;
  usage: {
    today: { spent: string };
    month: { spent: string };
    conversations: number;
  };
  catalogSync: CatalogSyncView | null;
  connector: ConnectorView | null;
  events: EventStatusView;
  movedFrom: string | null;
  billing?: BillingView;
}

/** `GET /v1/admin/store/events`: what O signed and the server holds for the relay. */
export interface StoredEventsView {
  events: unknown[];
}
