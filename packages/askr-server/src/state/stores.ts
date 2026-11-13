import {
  KIND_CATALOG_AUTH,
  type ConnectorPlatform,
  KIND_CONFIG,
  type SyncDiff,
  parseConfig,
} from '@elisym/askr';
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
/**
 * A stored event the relay explicitly refused this many times is no longer
 * retried until it is stored again. An unreachable relay never counts: its
 * events keep being retried at the backoff's interval.
 */
export const MAX_PUBLISH_ATTEMPTS = 8;
export const PUBLISH_BACKOFF_BASE_SECS = 60;
export const PUBLISH_BACKOFF_MAX_SECS = 60 * 60;

export type AddEventsResult =
  | { ok: true }
  | { ok: false; reason: 'too_many_events' }
  | { ok: false; reason: 'stale_config' | 'config_assistant'; id: string };

export interface StoreEventStatus {
  /** Events waiting for the relay, retried or not. */
  pending: number;
  /**
   * Events whose publish failed at least once: `failures` the relay's
   * refusals, `attempts` every failed publish; `stopped` once no longer retried.
   */
  failing: { id: string; kind: number; failures: number; attempts: number; stopped: boolean }[];
}

/** The last catalog sync of a store the admin started, on whichever instance (7.3). */
export type CatalogSyncStatus =
  | { state: 'running'; diff: SyncDiff }
  | { state: 'done'; diff: SyncDiff }
  | { state: 'failed'; diff: SyncDiff; error: string };

interface CatalogSyncRow extends Record<string, unknown> {
  holder: string | null;
  expires_at: number;
  state: 'running' | 'done' | 'failed' | null;
  diff: SyncDiff | null;
  error: string | null;
}

/** What a catalog sync whose instance stopped holding it (a crash) shows. */
export const SYNC_INTERRUPTED = 'The sync was interrupted';

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
   * config naming the rotation's new A completes the rotation only once the
   * relay accepted it (`markPublished`, 1.5), so the old A is served until
   * then; and once such a config is stored, a config naming the old A again
   * is refused (`config_assistant`): it would leave the relay naming a key the
   * rotation then discards. The running server is notified. All or nothing: a
   * new config not newer than the store's newest stored one is refused (the
   * relay would keep the newer one), and so is a batch past the per-store caps.
   */
  async addEvents(owner: string, events: readonly NostrEvent[]): Promise<AddEventsResult> {
    return this.db.transaction(async (tx) => {
      // One writer per store at a time, so the caps and the config order hold.
      const [store] = await tx.query<{ assistant: string; next_assistant: string | null }>(
        'select assistant, next_assistant from stores where owner = $1 for update',
        [owner],
      );
      if (store === undefined) {
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
      const next = store.next_assistant;
      const pendingConfigs =
        next === null
          ? []
          : await tx.query<{ event: NostrEvent }>(
              `select event from store_events
               where owner = $1 and not published and (event->>'kind')::int = $2`,
              [owner, KIND_CONFIG],
            );
      let rotating = pendingConfigs.some((row) => parseConfig(row.event)?.assistant === next);
      for (const event of fresh) {
        if (event.kind !== KIND_CONFIG) {
          continue;
        }
        if (newestConfig !== null && event.created_at <= newestConfig) {
          return { ok: false, reason: 'stale_config', id: event.id };
        }
        newestConfig = event.created_at;
        const named = parseConfig(event)?.assistant;
        if (next !== null && named === next) {
          rotating = true;
        } else if (rotating) {
          return { ok: false, reason: 'config_assistant', id: event.id };
        }
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
        await tx.query(
          'insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)',
          [event.id, owner, JSON.stringify(event)],
        );
      }
      await tx.query(
        `update store_events set publish_failures = 0, publish_attempts = 0, next_attempt_at = 0
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

  /**
   * What the admin shows (7.3): spend today and this month, live sessions,
   * conversations so far (sessions with at least one answered turn, counted
   * once each: `PgState.countConversation`), advisory clicks.
   */
  async usage(
    owner: string,
    assistant: string,
    now: number,
  ): Promise<{
    today: { spent: string; reserved: string };
    month: { spent: string };
    sessions: number;
    conversations: number;
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
    const [totals] = await this.db.query<{ conversations: number }>(
      'select conversations from store_totals where owner = $1',
      [owner],
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
      conversations: totals?.conversations ?? 0,
      clicks,
    };
  }

  /**
   * The store's own O-signed events the relay does not have yet, newest
   * first, as stored (7.3): what the admin of a store that is not active
   * shows its settings from. At most `MAX_UNPUBLISHED_EVENTS` (no more are
   * ever waiting) and `maxBytes` of JSON; `truncated` when older ones were
   * left out for the byte budget.
   */
  async storedEvents(
    owner: string,
    maxBytes: number,
  ): Promise<{ events: NostrEvent[]; truncated: boolean }> {
    const rows = await this.db.query<{ event: NostrEvent }>(
      `select event from store_events where owner = $1 and not published
       order by (event->>'created_at')::bigint desc, id limit $2`,
      [owner, MAX_UNPUBLISHED_EVENTS],
    );
    const events: NostrEvent[] = [];
    let bytes = 0;
    for (const { event } of rows) {
      bytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (bytes > maxBytes) {
        return { events, truncated: true };
      }
      events.push(event);
    }
    return { events, truncated: false };
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

  /**
   * Count a failed publish and back off, the interval doubling per failed
   * attempt up to the maximum; only a refusal (`refused`) counts toward the
   * stop. Returns the refusals so far.
   */
  async markPublishFailed(id: string, now: number, refused: boolean): Promise<number> {
    const [row] = await this.db.query<{ publish_failures: number }>(
      `update store_events set
         publish_failures = publish_failures + case when $5::boolean then 1 else 0 end,
         publish_attempts = publish_attempts + 1,
         next_attempt_at = $2::bigint
           + least($3::bigint * (1::bigint << least(publish_attempts, 16)), $4::bigint)
       where id = $1 returning publish_failures`,
      [id, now, PUBLISH_BACKOFF_BASE_SECS, PUBLISH_BACKOFF_MAX_SECS, refused],
    );
    return row?.publish_failures ?? 0;
  }

  /** What the admin shows about a store's stored events (7.3). */
  async eventStatus(owner: string): Promise<StoreEventStatus> {
    const rows = await this.db.query<{
      id: string;
      kind: number;
      publish_failures: number;
      publish_attempts: number;
    }>(
      `select id, (event->>'kind')::int8 as kind, publish_failures, publish_attempts from store_events
       where owner = $1 and not published order by (event->>'created_at')::bigint, id`,
      [owner],
    );
    return {
      pending: rows.length,
      failing: rows
        .filter((row) => row.publish_attempts > 0)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          failures: row.publish_failures,
          attempts: row.publish_attempts,
          stopped: row.publish_failures >= MAX_PUBLISH_ATTEMPTS,
        })),
    };
  }

  /**
   * The relay accepted a stored event. A config naming the rotation's new A
   * completes the rotation in the same step (1.5): only now does the store
   * switch to it, and the running server is notified.
   */
  async markPublished(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [stored] = await tx.query<{ owner: string }>(
        'select owner from store_events where id = $1',
        [id],
      );
      if (stored === undefined) {
        return;
      }
      // The store row before its events, as `addEvents` takes them.
      await tx.query('select 1 from stores where owner = $1 for update', [stored.owner]);
      const [row] = await tx.query<{ event: NostrEvent }>(
        'update store_events set published = true where id = $1 and not published returning event',
        [id],
      );
      const named =
        row !== undefined && row.event.kind === KIND_CONFIG
          ? parseConfig(row.event)?.assistant
          : undefined;
      if (named === undefined) {
        return;
      }
      const swapped = await tx.query(
        `update stores set assistant = next_assistant, assistant_key = next_assistant_key,
           next_assistant = null, next_assistant_key = null
         where owner = $1 and next_assistant = $2
         returning 1`,
        [stored.owner, named],
      );
      if (swapped.length > 0) {
        await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, stored.owner]);
      }
    });
  }

  /**
   * Take a store's catalog sync guard as `holder` until `now + holdSecs`;
   * false while another instance holds it (7.3, 7.4).
   */
  async claimCatalogSync(
    owner: string,
    holder: string,
    now: number,
    holdSecs: number,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `insert into catalog_syncs (owner, holder, expires_at) values ($1, $2, $3::bigint + $4::bigint)
       on conflict (owner) do update set holder = $2, expires_at = excluded.expires_at
       where catalog_syncs.holder is null or catalog_syncs.expires_at <= $3::bigint
       returning 1`,
      [owner, holder, now, holdSecs],
    );
    return rows.length > 0;
  }

  /** Keep holding the guard while the work runs; false once it is no longer `holder`'s. */
  async renewCatalogSync(
    owner: string,
    holder: string,
    now: number,
    holdSecs: number,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `update catalog_syncs set expires_at = $3::bigint + $4::bigint
       where owner = $1 and holder = $2 returning 1`,
      [owner, holder, now, holdSecs],
    );
    return rows.length > 0;
  }

  /** Record that `holder`'s catalog sync started publishing, with its preview's diff. */
  async startCatalogSync(
    owner: string,
    holder: string,
    diff: SyncDiff,
    now: number,
  ): Promise<void> {
    await this.db.query(
      `update catalog_syncs set state = 'running', diff = ($3::text)::jsonb, error = null, started_at = $4
       where owner = $1 and holder = $2`,
      [owner, holder, JSON.stringify(diff), now],
    );
  }

  /** Give the guard up, recording how the catalog sync ended when it ran one. */
  async releaseCatalogSync(
    owner: string,
    holder: string,
    ended?: CatalogSyncStatus,
  ): Promise<void> {
    if (ended === undefined) {
      await this.db.query(
        'update catalog_syncs set holder = null, expires_at = 0 where owner = $1 and holder = $2',
        [owner, holder],
      );
      return;
    }
    await this.db.query(
      `update catalog_syncs set holder = null, expires_at = 0,
         state = $3, diff = ($4::text)::jsonb, error = $5
       where owner = $1 and holder = $2`,
      [
        owner,
        holder,
        ended.state,
        JSON.stringify(ended.diff),
        ended.state === 'failed' ? ended.error : null,
      ],
    );
  }

  /** The store's last catalog sync; one still marked running that nobody holds was interrupted. */
  async catalogSync(owner: string, now: number): Promise<CatalogSyncStatus | null> {
    const [row] = await this.db.query<CatalogSyncRow>(
      'select holder, expires_at, state, diff, error from catalog_syncs where owner = $1',
      [owner],
    );
    if (row === undefined || row.state === null || row.diff === null) {
      return null;
    }
    if (row.state === 'running') {
      const held = row.holder !== null && row.expires_at > now;
      return held
        ? { state: 'running', diff: row.diff }
        : { state: 'failed', diff: row.diff, error: SYNC_INTERRUPTED };
    }
    return row.state === 'done'
      ? { state: 'done', diff: row.diff }
      : { state: 'failed', diff: row.diff, error: row.error ?? 'unknown error' };
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
