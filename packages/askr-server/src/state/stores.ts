import { KIND_CATALOG_AUTH, type ConnectorPlatform, KIND_CONFIG, parseConfig } from '@elisym/askr';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { type Db, STORES_CHANNEL } from '../db/db';
import type { KeyVault } from '../db/keys';
import { STORE_SELECT, monthStartDay, storeOf, utcDay } from './pg-state';
import type { StoreRecord, StoreStatus, Tier } from './types';

/** O-signed events awaiting publication per store at most, so nobody can fill the table (7.3). */
export const MAX_UNPUBLISHED_EVENTS = 50;
/** Stored events per store at most; published configs and authorizations a newer one replaced do not count. */
export const MAX_STORED_EVENTS = 1_000;
/** A stored event the relay refused this many times is no longer retried until it is stored again. */
export const MAX_PUBLISH_ATTEMPTS = 8;
const PUBLISH_BACKOFF_BASE_SECS = 60;
const PUBLISH_BACKOFF_MAX_SECS = 60 * 60;

export type AddEventsResult =
  | { ok: true }
  | { ok: false; reason: 'too_many_events' }
  | { ok: false; reason: 'stale_config'; id: string };

export interface StoreEventStatus {
  /** Events waiting for the relay, retried or not. */
  pending: number;
  /** Events the relay refused at least once; `stopped` once no longer retried. */
  failing: { id: string; kind: number; failures: number; stopped: boolean }[];
}

/** The `d` tag of a stored event, in SQL. */
function dTagOf(alias: string): string {
  return `(select tag->>1 from jsonb_array_elements(${alias}.event->'tags') tag where tag->>0 = 'd' limit 1)`;
}

/** Published configs and authorizations a newer published one of the same address replaced. */
const PRUNE_REPLACED_SQL = `
  delete from store_events e
  where e.owner = $1 and e.published and (e.event->>'kind')::int in (${KIND_CONFIG}, ${KIND_CATALOG_AUTH})
    and exists (
      select 1 from store_events n
      where n.owner = e.owner and n.published and n.id <> e.id
        and n.event->>'kind' = e.event->>'kind'
        and ${dTagOf('n')} is not distinct from ${dTagOf('e')}
        and (n.event->>'created_at')::bigint > (e.event->>'created_at')::bigint
    )`;

export interface ConnectorSettings {
  platform: ConnectorPlatform;
  url: string;
  /** Overrides the Shopify shop currency. */
  currency?: string;
  importPolicies: boolean;
}

export interface ConnectorRecord extends ConnectorSettings {
  owner: string;
  enabled: boolean;
  lastStatus: unknown;
  /** Unix ms. */
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface ScheduledConnector extends ConnectorRecord {
  storeId: string;
  intervalMs: number;
  maxProducts: number;
}

interface ConnectorRow extends Record<string, unknown> {
  owner: string;
  platform: ConnectorPlatform;
  url: string;
  currency: string | null;
  import_policies: boolean;
  enabled: boolean;
  last_status: unknown;
  last_run_at: number | null;
  next_run_at: number | null;
}

function connectorOf(row: ConnectorRow): ConnectorRecord {
  return {
    owner: row.owner,
    platform: row.platform,
    url: row.url,
    ...(row.currency === null ? {} : { currency: row.currency }),
    importPolicies: row.import_policies,
    enabled: row.enabled,
    lastStatus: row.last_status,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

/**
 * Stores, tiers and the O-signed events awaiting publication (7.3, K18, K19):
 * what the operator CLI and the admin API write.
 */
export class StoreDirectory {
  constructor(
    private readonly db: Db,
    private readonly vault: KeyVault,
  ) {}

  async setTier(tier: Tier): Promise<void> {
    await this.db.query(
      `insert into tiers (name, messages_per_session_per_day, daily_budget_usd, monthly_budget_usd,
         tickets_per_store_per_minute, max_products, sync_interval_minutes, branding)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (name) do update set
         messages_per_session_per_day = $2, daily_budget_usd = $3, monthly_budget_usd = $4,
         tickets_per_store_per_minute = $5, max_products = $6, sync_interval_minutes = $7,
         branding = $8`,
      [
        tier.name,
        tier.messagesPerSessionPerDay,
        tier.dailyBudgetUsd,
        tier.monthlyBudgetUsd,
        tier.ticketsPerStorePerMinute,
        tier.maxProducts,
        tier.syncIntervalMinutes,
        tier.branding,
      ],
    );
  }

  /**
   * A new `pending` store for O with a fresh A and server K (7.3), or the
   * existing one: onboarding twice never rotates keys.
   */
  async createStore(owner: string, now: number): Promise<StoreRecord> {
    const existing = await this.store(owner);
    if (existing) {
      return existing;
    }
    const assistantSecretKey = generateSecretKey();
    const catalogSecretKey = generateSecretKey();
    await this.db.query(
      `insert into stores (owner, status, assistant, assistant_key, catalog_key, catalog_key_secret, created_at)
       values ($1, 'pending', $2, $3, $4, $5, $6)
       on conflict (owner) do nothing`,
      [
        owner,
        getPublicKey(assistantSecretKey),
        this.vault.seal(assistantSecretKey, owner, 'assistant'),
        getPublicKey(catalogSecretKey),
        this.vault.seal(catalogSecretKey, owner, 'catalog'),
        now,
      ],
    );
    const created = await this.store(owner);
    if (!created) {
      throw new Error('store was not created');
    }
    return created;
  }

  async store(owner: string): Promise<StoreRecord | undefined> {
    const [row] = await this.db.query<Parameters<typeof storeOf>[0]>(
      `${STORE_SELECT} where s.owner = $1`,
      [owner],
    );
    return row ? storeOf(row, this.vault) : undefined;
  }

  /** A store's state and tier name without opening its keys. */
  async statusOf(owner: string): Promise<{ status: StoreStatus; tier: string | null } | undefined> {
    const [row] = await this.db.query<{ status: StoreStatus; tier: string | null }>(
      'select status, tier from stores where owner = $1',
      [owner],
    );
    return row;
  }

  async tierExists(name: string): Promise<boolean> {
    return (await this.db.query('select 1 from tiers where name = $1', [name])).length > 0;
  }

  async list(): Promise<{ owner: string; status: StoreStatus; tier: string | null }[]> {
    return this.db.query<{ owner: string; status: StoreStatus; tier: string | null }>(
      'select owner, status, tier from stores order by created_at',
    );
  }

  /**
   * Set a store's state (and tier on activation) and notify the running
   * server (7.3); false when there is no such store or tier, or when the
   * store would leave `pending` without a tier.
   */
  async setStatus(owner: string, status: StoreStatus, tierName?: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (tierName !== undefined) {
        const tiers = await tx.query('select 1 from tiers where name = $1', [tierName]);
        if (tiers.length === 0) {
          return false;
        }
      }
      const rows = await tx.query(
        `update stores set status = $2, tier = coalesce($3, tier)
         where owner = $1 and ($2 = 'pending' or coalesce($3, tier) is not null)
         returning 1`,
        [owner, status, tierName ?? null],
      );
      if (rows.length === 0) {
        return false;
      }
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
      return true;
    });
  }

  /**
   * Store O-signed events to publish once the store is active (7.3); a known
   * id is kept as is, except that one no longer retried is retried again. A
   * config naming the rotation's new A completes the rotation in the same
   * step (1.5), and the running server is notified. All or nothing: a new
   * config not newer than the store's newest stored one is refused (the relay
   * would keep the newer one while A switched here), and so is a batch past
   * the per-store caps.
   */
  async addEvents(owner: string, events: readonly NostrEvent[]): Promise<AddEventsResult> {
    return this.db.transaction(async (tx) => {
      // One writer per store at a time, so the caps and the config order hold.
      const stores = await tx.query('select 1 from stores where owner = $1 for update', [owner]);
      if (stores.length === 0) {
        throw new Error('no such store');
      }
      const ids = events.map((event) => event.id);
      const known = new Set(
        (
          await tx.query<{ id: string }>(
            'select id from store_events where owner = $1 and id = any($2::text[])',
            [owner, ids],
          )
        ).map((row) => row.id),
      );
      const fresh = events.filter(
        (event, index) => !known.has(event.id) && ids.indexOf(event.id) === index,
      );
      const [newest] = await tx.query<{ created_at: number | null }>(
        `select max((event->>'created_at')::bigint) as created_at from store_events
         where owner = $1 and (event->>'kind')::int = $2`,
        [owner, KIND_CONFIG],
      );
      let newestConfig = newest?.created_at ?? null;
      for (const event of fresh) {
        if (event.kind !== KIND_CONFIG) {
          continue;
        }
        if (newestConfig !== null && event.created_at <= newestConfig) {
          return { ok: false, reason: 'stale_config', id: event.id };
        }
        newestConfig = event.created_at;
      }
      await tx.query(PRUNE_REPLACED_SQL, [owner]);
      const [counts] = await tx.query<{ unpublished: number; total: number }>(
        `select (count(*) filter (where not published))::int8 as unpublished, count(*)::int8 as total
         from store_events where owner = $1`,
        [owner],
      );
      if (
        (counts?.unpublished ?? 0) + fresh.length > MAX_UNPUBLISHED_EVENTS ||
        (counts?.total ?? 0) + fresh.length > MAX_STORED_EVENTS
      ) {
        return { ok: false, reason: 'too_many_events' };
      }
      for (const event of fresh) {
        const named = event.kind === KIND_CONFIG ? parseConfig(event)?.assistant : undefined;
        if (named !== undefined) {
          await tx.query(
            `update stores set assistant = next_assistant, assistant_key = next_assistant_key,
               next_assistant = null, next_assistant_key = null
             where owner = $1 and next_assistant = $2`,
            [owner, named],
          );
        }
        await tx.query(
          'insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)',
          [event.id, owner, JSON.stringify(event)],
        );
      }
      await tx.query(
        `update store_events set publish_failures = 0, next_attempt_at = 0
         where owner = $1 and id = any($2::text[]) and publish_failures >= $3`,
        [owner, ids, MAX_PUBLISH_ATTEMPTS],
      );
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
      return { ok: true };
    });
  }

  /** The new A of a rotation in progress, started now if there is none (1.5). */
  async beginRotation(owner: string): Promise<string | undefined> {
    const next = generateSecretKey();
    await this.db.query(
      `update stores set next_assistant = $2, next_assistant_key = $3
       where owner = $1 and next_assistant is null`,
      [owner, getPublicKey(next), this.vault.seal(next, owner, 'assistant')],
    );
    const [row] = await this.db.query<{ next_assistant: string | null }>(
      'select next_assistant from stores where owner = $1',
      [owner],
    );
    return row?.next_assistant ?? undefined;
  }

  async nextAssistant(owner: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ next_assistant: string | null }>(
      'select next_assistant from stores where owner = $1',
      [owner],
    );
    return row?.next_assistant ?? undefined;
  }

  /** Record an admin authorization id until it expires; false when it was used (7.3). */
  async recordAuthId(id: string, expiresAt: number): Promise<boolean> {
    const rows = await this.db.query(
      `insert into admin_auth_ids (id, expires_at) values ($1, $2)
       on conflict (id) do nothing returning 1`,
      [id, expiresAt],
    );
    return rows.length > 0;
  }

  /** What the admin shows (7.3): spend today and this month, live sessions, advisory clicks. */
  async usage(
    owner: string,
    assistant: string,
    now: number,
  ): Promise<{
    today: { spent: string; reserved: string };
    month: { spent: string };
    sessions: number;
    clicks: { address: string; count: number }[];
  }> {
    const days = await this.db.query<{ day: number; spent: string; reserved: string }>(
      'select day, spent, reserved from store_days where owner = $1 and day >= $2',
      [owner, monthStartDay(now)],
    );
    const todayRow = days.find((row) => row.day === utcDay(now));
    const monthSpent = days.reduce((total, row) => total.plus(row.spent), new Decimal(0));
    const [sessions] = await this.db.query<{ count: number }>(
      'select count(*)::int8 as count from sessions where assistant = $1 and session_end > $2',
      [assistant, now],
    );
    const clicks = await this.db.query<{ address: string; count: number }>(
      'select address, count from clicks where owner = $1 order by count desc, address limit 100',
      [owner],
    );
    return {
      today: {
        spent: new Decimal(todayRow?.spent ?? '0').toString(),
        reserved: new Decimal(todayRow?.reserved ?? '0').toString(),
      },
      month: { spent: monthSpent.toString() },
      sessions: sessions?.count ?? 0,
      clicks,
    };
  }

  /**
   * Events of active stores not yet accepted by the relay and due at `now`
   * (past their backoff, under the attempt limit), oldest first.
   */
  async unpublishedEvents(
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<{ owner: string; event: NostrEvent }[]> {
    return this.db.query<{ owner: string; event: NostrEvent }>(
      `select e.owner, e.event from store_events e join stores s on s.owner = e.owner
       where not e.published and s.status = 'active'
         and e.publish_failures < $1 and e.next_attempt_at <= $2
       order by (e.event->>'created_at')::bigint, e.id`,
      [MAX_PUBLISH_ATTEMPTS, now],
    );
  }

  /** Count a refused or failed publish and back off; returns the failures so far. */
  async markPublishFailed(id: string, now: number): Promise<number> {
    const [row] = await this.db.query<{ publish_failures: number }>(
      `update store_events set publish_failures = publish_failures + 1,
         next_attempt_at = $2 + least($3 * (1 << least(publish_failures, 16)), $4)
       where id = $1 returning publish_failures`,
      [id, now, PUBLISH_BACKOFF_BASE_SECS, PUBLISH_BACKOFF_MAX_SECS],
    );
    return row?.publish_failures ?? 0;
  }

  /** What the admin shows about a store's stored events (7.3). */
  async eventStatus(owner: string): Promise<StoreEventStatus> {
    const rows = await this.db.query<{ id: string; kind: number; publish_failures: number }>(
      `select id, (event->>'kind')::int8 as kind, publish_failures from store_events
       where owner = $1 and not published order by (event->>'created_at')::bigint, id`,
      [owner],
    );
    return {
      pending: rows.length,
      failing: rows
        .filter((row) => row.publish_failures > 0)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          failures: row.publish_failures,
          stopped: row.publish_failures >= MAX_PUBLISH_ATTEMPTS,
        })),
    };
  }

  async markPublished(id: string): Promise<void> {
    await this.db.query('update store_events set published = true where id = $1', [id]);
  }

  /** Save a connector's settings (7.4); a changed source is disabled until previewed again. */
  async setConnector(owner: string, settings: ConnectorSettings): Promise<void> {
    await this.db.query(
      `insert into connectors (owner, platform, url, currency, import_policies)
       values ($1, $2, $3, $4, $5)
       on conflict (owner) do update set
         enabled = connectors.enabled and connectors.platform = $2 and connectors.url = $3,
         platform = $2, url = $3, currency = $4, import_policies = $5`,
      [owner, settings.platform, settings.url, settings.currency ?? null, settings.importPolicies],
    );
  }

  async connector(owner: string): Promise<ConnectorRecord | undefined> {
    const [row] = await this.db.query<ConnectorRow>('select * from connectors where owner = $1', [
      owner,
    ]);
    return row ? connectorOf(row) : undefined;
  }

  async enableConnector(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      'update connectors set enabled = true where owner = $1 returning 1',
      [owner],
    );
    return rows.length > 0;
  }

  async removeConnector(owner: string): Promise<void> {
    await this.db.query('delete from connectors where owner = $1', [owner]);
  }

  /**
   * Enabled connectors of active stores `holder` leases, with the tier's
   * interval and product cap (K19): one instance syncs a store, the one
   * whose worker has its config.
   */
  async scheduledConnectors(holder: string, now: number): Promise<ScheduledConnector[]> {
    const rows = await this.db.query<
      ConnectorRow & { sync_interval_minutes: number; max_products: number }
    >(
      `select c.*, t.sync_interval_minutes, t.max_products from connectors c
       join stores s on s.owner = c.owner join tiers t on t.name = s.tier
       join leases l on l.owner = c.owner
       where c.enabled and s.status = 'active' and l.holder = $1 and l.expires_at > $2`,
      [holder, now],
    );
    return rows.map((row) => ({
      ...connectorOf(row),
      storeId: row.owner,
      intervalMs: row.sync_interval_minutes * 60_000,
      maxProducts: row.max_products,
    }));
  }

  async saveConnectorStatus(
    owner: string,
    status: unknown,
    at: number,
    nextRunAt: number | null,
  ): Promise<void> {
    await this.db.query(
      `update connectors set last_status = ($2::text)::jsonb, last_run_at = $3, next_run_at = $4
       where owner = $1`,
      [owner, JSON.stringify(status), at, nextRunAt],
    );
  }
}
