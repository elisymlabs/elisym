/**
 * What PayCore's server answers hosted mode (`packages/paycore-server/src/admin/api.ts`,
 * `/v1/meta`), as JSON: fields the server leaves undefined are absent.
 */
import type { NostrEvent } from 'nostr-tools';

export type Network = 'mainnet' | 'devnet';

export type StoreStatus = 'pending' | 'active' | 'degraded' | 'halted' | 'suspending' | 'suspended';

export type EvmCredit = 'fast' | 'safe';

/** The owner event kinds the server prepares: 10133 (payout list), 30490 (authorization). */
export type OwnerEventKind = 10133 | 30490;

export interface Payout {
  caip19: string;
  address: string;
  signature?: string;
}

/** `GET /v1/meta`: public, unsigned. */
export interface Meta {
  /** The server's `PAYCORE_PUBLIC_BASE`: what NIP-98 `u` is checked against. */
  publicBase: string;
  operator: string;
  networks: Partial<Record<Network, { coins: string[] }>>;
  /** The inbox relays a store may name. */
  inboxRelays: string[];
  pendingMaxProducts: number;
}

export interface StoreConfig {
  name: string;
  nip05?: string;
  network: Network;
  draftPayouts: Payout[];
  evmCredit: EvmCredit;
  webhookUrl?: string;
  inboxRelays: string[];
  activeInboxRelays: string[];
  revision: number;
  updatedAt: number;
}

/** An O-signed event the server holds, and when it reached the relays. */
export interface CommittedOwnerEvent {
  event: NostrEvent;
  committedAt: number;
  publishedAt: number | null;
}

/** `GET /v1/admin/store`. */
export interface StoreView {
  owner: string;
  storePubkey: string;
  status: StoreStatus;
  /** Open alert kinds (never their texts): the admin says each in a fixed sentence. */
  alerts: string[];
  tier: string | null;
  /** The cap that applies: the tier's, or the pending one. */
  maxProducts: number | null;
  suspendingSince: number | null;
  createdAt: number;
  config: StoreConfig | null;
  activePayouts: { createdAt: number; payouts: Payout[] } | null;
  webhookSecretSet: boolean;
  payouts: { needsSigning: boolean };
  ownerEvents: { payto: CommittedOwnerEvent | null; auth: CommittedOwnerEvent | null };
}

export interface CreateStoreInput {
  name: string;
  network: Network;
  nip05?: string;
}

/** The whole config, built from the last read plus the edit, at the revision it was read at. */
export interface ConfigInput {
  name: string;
  nip05?: string;
  payouts: Payout[];
  evmCredit?: EvmCredit;
  webhookUrl?: string | null;
  inboxRelays: string[];
  expectedRevision: number;
}

export interface ProductRecord {
  d: string;
  title: string;
  description: string;
  summary?: string;
  url?: string;
  priceUsd: string;
  onSale: boolean;
  updatedAt: number;
}

export interface ProductInput {
  title: string;
  description: string;
  summary?: string;
  url?: string;
  priceUsd: string;
  onSale?: boolean;
}

export type RequestState = 'pending' | 'applied' | 'failed';

/** A queued change the store's holder applies. `result` is a whitelisted shape, never a raw text. */
export interface RequestView {
  id: string;
  kind: string;
  state: RequestState;
  result: unknown;
  createdAt: number;
  appliedAt: number | null;
}

/** An answer that follows a queued request: applied (200), failed (422), or still pending (202). */
export interface RequestAnswer {
  request: { id: string; state: 'pending' } | RequestView;
}

export interface CommitAnswer {
  id: string;
  alreadyCommitted?: true;
  request?: RequestAnswer['request'];
}

export interface OrderView {
  key: string;
  buyerPubkey: string;
  orderId: string;
  product: string;
  /** The product's current title by `d`; null when it was deleted. */
  productTitle?: string | null;
  createdAt: number;
  email?: string;
  customerRef?: string;
  reportedTxs: string[];
  paid?: {
    signature: string;
    amount: string;
    fee: string;
    caip19: string;
    medium: string;
    blockTime: number;
  };
  webhook?: { state: string; attempts: number; lastStatus?: number };
  deliveredAt?: number;
}

export interface OrdersView {
  orders: OrderView[];
  answeredByHand: Record<string, { kind: string; tx?: string; amount?: string; caip19?: string }>;
  unresolvedPayments: { key: string; tx: string; at: number }[];
}

export type HandInput =
  | { kind: 'complete' }
  | { kind: 'refunded'; tx: string; amount: string; asset?: string };
