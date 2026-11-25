import {
  KIND_CATALOG_AUTH,
  type ConnectorPlatform,
  KIND_CONFIG,
  type SyncDiff,
  parseConfig,
} from '@elisym/askr';
import { KIND_DELETION, nowSecs } from '@elisym/commerce';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { type Db, type Queryable, STORES_CHANNEL } from '../db/db';
import type { KeyVault } from '../db/keys';
import { budgetWindow } from './budget-window';
import { type HeldOrigin, ORIGIN_PROOF_AGE_SECS, noteOrigins, noteOriginsLocked } from './origins';
import { MAX_MOVE_HOPS, STORE_SELECT, followMoves, storeOf, utcDay } from './pg-state';
import type { StoreRecord, StoreStatus, Tier } from './types';

/** Postgres' unique_violation. */
const UNIQUE_VIOLATION = '23505';

/** How many days of activity the admin shows, today included. */
export const ACTIVITY_DAYS = 30;

/** One UTC day of what the widget did (`activity_days`). */
export interface ActivityDay {
  /** Days since the Unix epoch, UTC. */
  day: number;
  conversations: number;
  answers: number;
  links: number;
  carts: number;
  /** Buy presses on PayCore cards and payments their checkout reported (advisory, C6). */
  buys: number;
  paid: number;
}

/** Tables keyed by a store's owner without a foreign key: moved along with it (K21). */
const OWNER_TABLES = ['sessions', 'store_days', 'reservations', 'clicks', 'store_totals'] as const;

export {
  type HeldOrigin,
  MAX_PROOF_ORIGINS,
  ORIGIN_DROPPED_GRACE_SECS,
  ORIGIN_PROOF_AGE_SECS,
  SHARED_HOST_SUFFIXES,
  proofOrigins,
} from './origins';

export type MoveResult = { ok: true } | { ok: false; reason: 'no_store' | 'moved' | 'taken' };

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

/** How a catalog sync the admin started stands or ended, as recorded on release (7.3). */
export type CatalogSyncEnd =
  | { state: 'running'; diff: SyncDiff }
  | { state: 'done'; diff: SyncDiff }
  | { state: 'failed'; diff: SyncDiff; error: string };

/**
 * The last catalog sync of a store the admin started, on whichever instance (7.3): `syncId` is
 * the id its 202 answered with; `startedAt` and `finishedAt` are unix seconds, null when not
 * recorded (rows older than 0008, a sync still running or one that was interrupted).
 */
export type CatalogSyncStatus = CatalogSyncEnd & {
  syncId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

interface CatalogSyncRow extends Record<string, unknown> {
  holder: string | null;
  expires_at: number;
  state: 'running' | 'done' | 'failed' | null;
  diff: SyncDiff | null;
  error: string | null;
  sync_id: string | null;
  started_at: number | null;
  finished_at: number | null;
}

/**
 * The advisory lock self-serve Free activations take (6.1), so two instances
 * cannot both pass a cap. Its own: not the migrations' `LOCK_ID` (`db/migrations.ts`).
 */
export const FREE_PLAN_LOCK_ID = 7_301_996;

/** A per-owner transaction lock: opening a store and moving one away from that key take turns. */
const OWNER_LOCK_SQL = `select pg_advisory_xact_lock(hashtextextended('askr:store-owner:' || $1, 0))`;

/** Opening a store under a key a store moved away from: that key never opens a store again. */
export class StoreMovedError extends Error {
  constructor() {
    super('a store moved away from this key');
    this.name = 'StoreMovedError';
  }
}

/** A NUL or a lone surrogate, which a jsonb column refuses. */
const NUL = String.fromCharCode(0);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function jsonbRefuses(text: string): boolean {
  return text.includes(NUL) || LONE_SURROGATE_RE.test(text);
}

/**
 * The JSON text of `value` for a jsonb column, or null when some string in it is one jsonb
 * refuses: a signed event with such text (anyone holding the old key can sign one) must never
 * make the statement fail, so it is dropped instead.
 */
export function jsonbText(value: unknown): string | null {
  let storable = true;
  const text = JSON.stringify(value, (key: string, entry: unknown) => {
    if (jsonbRefuses(key) || (typeof entry === 'string' && jsonbRefuses(entry))) {
      storable = false;
    }
    return entry;
  });
  return storable ? text : null;
}
const DAY_SECS = 24 * 60 * 60;

/**
 * What a merchant's Free choice did to a store that qualifies (6.1):
 * `activated` on the Free tier, refused at a cap (`capacity_reached`), or the
 * Free tier missing (`no_tier`).
 */
export type FreeActivation = 'activated' | 'capacity_reached' | 'no_tier';

/** What a catalog sync whose instance stopped holding it (a crash) shows. */
export const SYNC_INTERRUPTED = 'The sync was interrupted';

/** The `d` tag of a stored event, in SQL. */
function dTagOf(alias: string): string {
  return `(select tag->>1 from jsonb_array_elements(${alias}.event->'tags') tag where tag->>0 = 'd' limit 1)`;
}

/**
 * What a newer stored event of the same kind replaces, in SQL: the `d` tag of
 * a config or authorization, the sorted `a` targets of a deletion (a newer
 * deletion of the same addresses deletes all the older one does). Read-backs
 * key them the same way (`addressOf`).
 */
function replaceKeyOf(alias: string): string {
  return `case when (${alias}.event->>'kind')::int = ${KIND_DELETION}
    then (select string_agg(tag->>1, ' ' order by tag->>1)
          from jsonb_array_elements(${alias}.event->'tags') tag where tag->>0 = 'a')
    else ${dTagOf(alias)} end`;
}

/**
 * Configs, authorizations and deletions a newer stored one of the same kind
 * and key replaced: a published one once the newer one is published too; one
 * still waiting as soon as a newer one is stored that is published or still
 * retried (the relay would keep only the newer, so the older one need not
 * count against the caps). One whose newer one was stopped stays, so the
 * relay is not left without either. The kind is matched on its own: a key
 * alone could name a config and an authorization alike.
 */
const PRUNE_REPLACED_SQL = `
  delete from store_events e
  where e.owner = $1
    and (e.event->>'kind')::int in (${KIND_CONFIG}, ${KIND_CATALOG_AUTH}, ${KIND_DELETION})
    and exists (
      select 1 from store_events n
      where n.owner = e.owner and n.id <> e.id
        and (n.published or (not e.published and n.publish_failures < $2))
        and n.event->>'kind' = e.event->>'kind'
        and ${replaceKeyOf('n')} is not distinct from ${replaceKeyOf('e')}
        and (n.event->>'created_at')::bigint > (e.event->>'created_at')::bigint
    )`;

/** A batch past a per-store cap: thrown so the transaction rolls its inserts back. */
class EventCapExceeded extends Error {}

/** What keeps an event current in a read-back: its address, or for a deletion what it deletes. */
function addressOf(event: NostrEvent): string {
  if (event.kind === KIND_DELETION) {
    const targets = event.tags
      .filter((tag) => tag[0] === 'a')
      .map((tag) => tag[1] ?? '')
      .sort();
    return `${KIND_DELETION}:${targets.join(' ')}`;
  }
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  return `${event.kind}:${event.pubkey}:${d}`;
}

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
 * Whether a self-serve Free activation at `now` would pass a cap (6.1): `perDay` per rolling 24
 * hours, `maxActive` self-serve stores active on `tier`. Run under `FREE_PLAN_LOCK_ID`.
 */
export async function freeCapacityReached(
  tx: Queryable,
  tier: string,
  now: number,
  caps: { perDay: number; maxActive: number },
): Promise<boolean> {
  const [counts] = await tx.query<{ today: number; active: number }>(
    `select
       (count(*) filter (where auto_activated_at > $1))::int8 as today,
       (count(*) filter (where status = 'active' and tier = $2
                         and auto_activated_at is not null))::int8 as active
     from stores`,
    [now - DAY_SECS, tier],
  );
  return (counts?.today ?? 0) >= caps.perDay || (counts?.active ?? 0) >= caps.maxActive;
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
      // daily_budget_usd is no longer read; it is written as the monthly budget until a later
      // migration drops it, so a rolled-back release reads no extra daily limit.
      `insert into tiers (name, messages_per_session_per_day, monthly_budget_usd,
         tickets_per_store_per_minute, max_products, sync_interval_minutes, branding,
         daily_budget_usd)
       values ($1, $2, $3, $4, $5, $6, $7, $3)
       on conflict (name) do update set
         messages_per_session_per_day = $2, monthly_budget_usd = $3, daily_budget_usd = $3,
         tickets_per_store_per_minute = $4, max_products = $5, sync_interval_minutes = $6,
         branding = $7`,
      [
        tier.name,
        tier.messagesPerSessionPerDay,
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
    await this.db.transaction(async (tx) => {
      // Under the owner's lock a move away from it has either committed (and is seen here) or
      // waits until this store exists, so a key a store moved away from never opens a new one.
      await tx.query(OWNER_LOCK_SQL, [owner]);
      const moved = await tx.query('select 1 from store_moves where from_owner = $1', [owner]);
      if (moved.length > 0) {
        throw new StoreMovedError();
      }
      await tx.query(
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
    });
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

  /** Who set the store's tier (`operator`, `free`, `billing`), or null with no plan. */
  async planSourceOf(owner: string): Promise<string | null | undefined> {
    const [row] = await this.db.query<{ plan_source: string | null }>(
      'select plan_source from stores where owner = $1',
      [owner],
    );
    return row?.plan_source;
  }

  /** Every tier with how many stores are on it, by name. */
  async listTiers(): Promise<{ tier: Tier; stores: number }[]> {
    const rows = await this.db.query<{
      name: string;
      messages_per_session_per_day: number;
      monthly_budget_usd: string;
      tickets_per_store_per_minute: number;
      max_products: number;
      sync_interval_minutes: number;
      branding: boolean;
      stores: number;
    }>(
      `select t.*, (select count(*)::int from stores s where s.tier = t.name) as stores
       from tiers t order by t.name`,
    );
    return rows.map((row) => ({
      tier: {
        name: row.name,
        messagesPerSessionPerDay: row.messages_per_session_per_day,
        monthlyBudgetUsd: row.monthly_budget_usd,
        ticketsPerStorePerMinute: row.tickets_per_store_per_minute,
        maxProducts: row.max_products,
        syncIntervalMinutes: row.sync_interval_minutes,
        branding: row.branding,
      },
      stores: row.stores,
    }));
  }

  /**
   * Delete a tier no store is on. A store keeps its tier name while suspended
   * too, so the stores on it are named instead and nothing is deleted.
   */
  async deleteTier(
    name: string,
  ): Promise<{ deleted: true } | { deleted: false; stores: string[] } | undefined> {
    return this.db.transaction(async (tx) => {
      const tiers = await tx.query('select 1 from tiers where name = $1 for update', [name]);
      if (tiers.length === 0) {
        return undefined;
      }
      const stores = await tx.query<{ owner: string }>(
        'select owner from stores where tier = $1 order by created_at',
        [name],
      );
      if (stores.length > 0) {
        return { deleted: false, stores: stores.map((store) => store.owner) };
      }
      await tx.query('delete from tiers where name = $1', [name]);
      return { deleted: true };
    });
  }

  async tierExists(name: string): Promise<boolean> {
    return (await this.db.query('select 1 from tiers where name = $1', [name])).length > 0;
  }

  /**
   * Every store for the operator, with its contact email and how much its widget was used in the
   * last `ACTIVITY_DAYS` days (questions answered), to tell who to write to.
   */
  async list(now: number = nowSecs()): Promise<
    {
      owner: string;
      status: StoreStatus;
      tier: string | null;
      email: string | null;
      answers: number;
    }[]
  > {
    return this.db.query(
      `select s.owner, s.status, s.tier, s.contact_email as email,
         coalesce((select sum(a.answers) from activity_days a
                   where a.owner = s.owner and a.day > $1), 0)::int4 as answers
       from stores s order by s.created_at`,
      [utcDay(now) - ACTIVITY_DAYS],
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
        // `for share` waits for a `tier delete` under way, so a deleted tier reads as none.
        const tiers = await tx.query('select 1 from tiers where name = $1 for share', [tierName]);
        if (tiers.length === 0) {
          return false;
        }
      }
      const rows = await tx.query(
        // A tier the operator sets is the operator's: billing no longer changes the store.
        `update stores set status = $2, tier = coalesce($3, tier),
           plan_source = case when $3::text is null then plan_source else 'operator' end
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
   * Put a pending store that never had a tier on the Free tier `tier` when its
   * owner chooses Free (6.1), unless a cap is reached: `perDay` activations per
   * rolling 24 hours, `maxActive` self-serve stores active on `tier`. Null when
   * the store does not qualify (any more): another request or the operator
   * changed it meanwhile. Notifies the running servers in the same transaction.
   * `auto_activated_at` (named before the explicit choice, kept to need no
   * migration) records the time of that self-serve Free activation.
   */
  async activateFree(
    owner: string,
    tier: string,
    now: number,
    caps: { perDay: number; maxActive: number },
  ): Promise<FreeActivation | null> {
    return this.db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1)', [FREE_PLAN_LOCK_ID]);
      // Every read below runs after the lock, under Postgres' default READ COMMITTED: each
      // statement sees what earlier holders of the lock committed. Under REPEATABLE READ the
      // snapshot would predate the lock, and two activations could both pass a cap.
      const qualifies = await tx.query(
        `select 1 from stores where owner = $1 and status = 'pending' and tier is null for update`,
        [owner],
      );
      if (qualifies.length === 0) {
        return null;
      }
      // `for share` waits for a `tier delete` under way, so a deleted tier reads as none.
      const tiers = await tx.query('select 1 from tiers where name = $1 for share', [tier]);
      if (tiers.length === 0) {
        return 'no_tier';
      }
      if (await freeCapacityReached(tx, tier, now, caps)) {
        return 'capacity_reached';
      }
      await tx.query(
        `update stores set status = 'active', tier = $2, auto_activated_at = $3, plan_source = 'free'
         where owner = $1 and status = 'pending' and tier is null`,
        [owner, tier, now],
      );
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
      return 'activated';
    });
  }

  /** Whether the server holds a config `owner` signed that parses (it lists at least one origin). */
  async hasStoredConfig(owner: string): Promise<boolean> {
    const rows = await this.db.query<{ event: NostrEvent }>(
      `select event from store_events where owner = $1 and (event->>'kind')::int = $2`,
      [owner, KIND_CONFIG],
    );
    return rows.some((row) => parseConfig(row.event) !== undefined);
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
    try {
      return await this.addEventsOnce(owner, events);
    } catch (error) {
      if (error instanceof EventCapExceeded) {
        return { ok: false, reason: 'too_many_events' };
      }
      throw error;
    }
  }

  private async addEventsOnce(
    owner: string,
    events: readonly NostrEvent[],
  ): Promise<AddEventsResult> {
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
      for (const event of fresh) {
        await tx.query(
          'insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)',
          [event.id, owner, JSON.stringify(event)],
        );
        const origins = event.kind === KIND_CONFIG ? parseConfig(event)?.origins : undefined;
        if (origins !== undefined && origins.length > 0) {
          // Dated by the server's clock, never the event's: a backdated config proves nothing.
          await noteOriginsLocked(tx, owner, origins, nowSecs());
        }
      }
      // After the batch is in, so what it replaces makes room for it; past a cap the throw rolls it back.
      await tx.query(PRUNE_REPLACED_SQL, [owner, MAX_PUBLISH_ATTEMPTS]);
      const [counts] = await tx.query<{ unpublished: number; total: number }>(
        `select (count(*) filter (where not published))::int8 as unpublished, count(*)::int8 as total
         from store_events where owner = $1`,
        [owner],
      );
      if (
        (counts?.unpublished ?? 0) > MAX_UNPUBLISHED_EVENTS ||
        (counts?.total ?? 0) > MAX_STORED_EVENTS
      ) {
        throw new EventCapExceeded();
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

  /**
   * Remember the origins a config of `owner` lists, each from when it was
   * first seen (K21): never forgotten when a later config drops it.
   */
  async noteOrigins(owner: string, origins: readonly string[], now: number): Promise<void> {
    if (origins.length === 0) {
      return;
    }
    await noteOrigins(this.db, owner, origins, now);
  }

  /** Every origin a config of `owner` has listed, with when it was first seen, oldest first (K21). */
  async originsHeld(owner: string): Promise<HeldOrigin[]> {
    const rows = await this.db.query<{
      origin: string;
      first_seen: string | number;
      last_seen: string | number;
    }>(
      `select origin, first_seen, last_seen from store_origins where owner = $1
       order by first_seen, origin`,
      [owner],
    );
    return rows.map((row) => ({
      origin: row.origin,
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
    }));
  }

  /** The secret key of the next A while a rotation is under way (1.5). */
  async nextAssistantSecret(owner: string): Promise<Uint8Array | undefined> {
    const [row] = await this.db.query<{ next_assistant_key: Uint8Array | null }>(
      'select next_assistant_key from stores where owner = $1',
      [owner],
    );
    const sealed = row?.next_assistant_key ?? null;
    return sealed === null ? undefined : this.vault.open(sealed, owner, 'assistant');
  }

  /** The owner a store embedded as `owner` moved to (K21). */
  movedTo(owner: string): Promise<string | undefined> {
    return followMoves(this.db, owner);
  }

  /** Whether `owner` is a key a store moved away from: it can never be a store again. */
  async wasMoved(owner: string): Promise<boolean> {
    const rows = await this.db.query('select 1 from store_moves where from_owner = $1', [owner]);
    return rows.length > 0;
  }

  /** Every owner key this store had before `owner`, the most recent first (K21). */
  async formerOwners(owner: string): Promise<string[]> {
    const rows = await this.db.query<{ owner: string }>(
      `with recursive chain (owner, hops) as (
         select $1::text, 0
         union all
         select m.from_owner, chain.hops + 1 from store_moves m
         join chain on m.to_owner = chain.owner
         where chain.hops < $2
       )
       select owner from chain where hops > 0 order by hops`,
      [owner, MAX_MOVE_HOPS],
    );
    return rows.map((row) => row.owner);
  }

  /** The owner key this store last moved from, and the settings it had signed (K21). */
  async movedFrom(owner: string): Promise<{ from: string; config: NostrEvent | null } | undefined> {
    const [row] = await this.db.query<{ from_owner: string; config: NostrEvent | null }>(
      `select from_owner, config from store_moves where to_owner = $1
       order by moved_at desc limit 1`,
      [owner],
    );
    return row === undefined ? undefined : { from: row.from_owner, config: row.config };
  }

  /**
   * Move a store from owner key `from` to `to` (K21, 1.6): the row and all
   * that is keyed by its owner follow; A and K are kept, sealed again for
   * `to`; the events `from` signed are dropped. The caller checked the proof.
   */
  async moveStore(
    from: string,
    to: string,
    now: number,
    config: NostrEvent | undefined,
  ): Promise<MoveResult> {
    try {
      return await this.moveStoreOnce(from, to, now, config);
    } catch (error) {
      // Another move to `to`, or `to` opening a store, won the race: that key is taken.
      if (Reflect.get(Object(error), 'code') === UNIQUE_VIOLATION) {
        return { ok: false, reason: 'taken' };
      }
      throw error;
    }
  }

  private async moveStoreOnce(
    from: string,
    to: string,
    now: number,
    config: NostrEvent | undefined,
  ): Promise<MoveResult> {
    return this.db.transaction(async (tx) => {
      await tx.query(OWNER_LOCK_SQL, [from]);
      const [row] = await tx.query<{
        assistant_key: Uint8Array;
        catalog_key_secret: Uint8Array;
        next_assistant_key: Uint8Array | null;
      }>(
        'select assistant_key, catalog_key_secret, next_assistant_key from stores where owner = $1 for update',
        [from],
      );
      if (row === undefined) {
        const moved = await tx.query('select 1 from store_moves where from_owner = $1', [from]);
        return { ok: false, reason: moved.length > 0 ? 'moved' : 'no_store' };
      }
      const taken = await tx.query(
        `select 1 from stores where owner = $1
         union all select 1 from store_moves where from_owner = $1`,
        [to],
      );
      if (taken.length > 0) {
        return { ok: false, reason: 'taken' };
      }
      const reseal = (sealed: Uint8Array, purpose: 'assistant' | 'catalog') =>
        this.vault.seal(this.vault.open(sealed, from, purpose), to, purpose);
      await tx.query('delete from store_events where owner = $1', [from]);
      // Expired, not deleted: whoever takes it next does so under a new epoch, so an ask of the old
      // lease never looks live again.
      await tx.query('update leases set expires_at = 0 where owner = $1', [from]);
      // Sites too young to prove anything yet go: one a thief listed just before the owner moved
      // the store would otherwise come of age under the new key and take it back.
      await tx.query('delete from store_origins where owner = $1 and first_seen > $2', [
        from,
        now - ORIGIN_PROOF_AGE_SECS,
      ]);
      // A sync running under the old key releases under it, which no longer matches: free the guard.
      await tx.query('update catalog_syncs set holder = null, expires_at = 0 where owner = $1', [
        from,
      ]);
      await tx.query(
        `update stores set owner = $2, assistant_key = $3, catalog_key_secret = $4,
           next_assistant_key = $5
         where owner = $1`,
        [
          from,
          to,
          reseal(row.assistant_key, 'assistant'),
          reseal(row.catalog_key_secret, 'catalog'),
          row.next_assistant_key === null ? null : reseal(row.next_assistant_key, 'assistant'),
        ],
      );
      for (const table of OWNER_TABLES) {
        await tx.query(`update ${table} set owner = $2 where owner = $1`, [from, to]);
      }
      await tx.query(
        `insert into store_moves (from_owner, to_owner, moved_at, config)
         values ($1, $2, $3, ($4::text)::jsonb)`,
        [from, to, now, config === undefined ? null : jsonbText(config)],
      );
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, from]);
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, to]);
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
   * What the admin shows (7.3): spend today and in the budget window (`month`, the name kept;
   * `budgetWindow`, the one a turn's reservation counts) with when that window ends, live sessions,
   * conversations so far (sessions with at least one answered turn, counted
   * once each: `PgState.countConversation`), advisory clicks.
   */
  async usage(
    owner: string,
    assistant: string,
    now: number,
  ): Promise<{
    today: { spent: string; reserved: string };
    month: { spent: string; reserved: string };
    /** `resetsAt`: Unix seconds, when the budget window ends and the budget is whole again. */
    budget: { resetsAt: number };
    sessions: number;
    conversations: number;
    clicks: { address: string; count: number; carts: number; buys: number; paid: number }[];
    days: ActivityDay[];
  }> {
    const window = await budgetWindow(this.db, owner, now);
    const days = await this.db.query<{ day: number; spent: string; reserved: string }>(
      'select day, spent, reserved from store_days where owner = $1 and day >= $2',
      [owner, window.startDay],
    );
    const todayRow = days.find((row) => row.day === utcDay(now));
    const monthSpent = days.reduce((total, row) => total.plus(row.spent), new Decimal(0));
    const monthReserved = days.reduce((total, row) => total.plus(row.reserved), new Decimal(0));
    const [sessions] = await this.db.query<{ count: number }>(
      'select count(*)::int8 as count from sessions where assistant = $1 and session_end > $2',
      [assistant, now],
    );
    const [totals] = await this.db.query<{ conversations: number }>(
      'select conversations from store_totals where owner = $1',
      [owner],
    );
    const clicks = await this.db.query<{
      address: string;
      count: number;
      carts: number;
      buys: number;
      paid: number;
    }>(
      // The admin lists page opens and cart presses; Buy presses and payments are the operator's.
      `select address, count, carts, buys, paid from clicks where owner = $1 and count + carts > 0
       order by count + carts desc, carts desc, address limit 100`,
      [owner],
    );
    return {
      today: {
        spent: new Decimal(todayRow?.spent ?? '0').toString(),
        reserved: new Decimal(todayRow?.reserved ?? '0').toString(),
      },
      month: { spent: monthSpent.toString(), reserved: monthReserved.toString() },
      budget: { resetsAt: window.resetsAt },
      sessions: sessions?.count ?? 0,
      conversations: totals?.conversations ?? 0,
      clicks,
      days: await this.db.query<{
        day: number;
        conversations: number;
        answers: number;
        links: number;
        carts: number;
        buys: number;
        paid: number;
      }>(
        `select day, conversations, answers, links, carts, buys, paid from activity_days
         where owner = $1 and day > $2 order by day`,
        [owner, utcDay(now) - ACTIVITY_DAYS],
      ),
    };
  }

  /** Where the operator reaches the store's owner; private, never published (7.3). */
  async contactEmail(owner: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ contact_email: string | null }>(
      'select contact_email from stores where owner = $1',
      [owner],
    );
    return row?.contact_email ?? undefined;
  }

  /** Set or clear (`undefined`) the store's contact email. */
  async setContactEmail(owner: string, email: string | undefined): Promise<void> {
    await this.db.query('update stores set contact_email = $2 where owner = $1', [
      owner,
      email ?? null,
    ]);
  }

  /**
   * The store's own O-signed events the relay does not have yet and will
   * still get, newest first, as stored (7.3): what the admin of a store that
   * is not active shows its settings from. One whose publishing was stopped
   * (the relay refused it) is left out: it is not on its way, so the admin
   * signs it again. The newest per address (per deleted addresses for a
   * deletion) is always included, so nothing current is missing; older ones
   * only within `maxBytes` of JSON, `truncated` when some were left out. At
   * most `MAX_UNPUBLISHED_EVENTS` rows are read: no more are ever waiting.
   */
  async storedEvents(
    owner: string,
    maxBytes: number,
  ): Promise<{ events: NostrEvent[]; truncated: boolean }> {
    const rows = await this.db.query<{ event: NostrEvent }>(
      `select event from store_events where owner = $1 and not published and publish_failures < $3
       order by (event->>'created_at')::bigint desc, id limit $2`,
      [owner, MAX_UNPUBLISHED_EVENTS, MAX_PUBLISH_ATTEMPTS],
    );
    const sizeOf = (event: NostrEvent) => Buffer.byteLength(JSON.stringify(event), 'utf8');
    const seen = new Set<string>();
    const current = new Set<NostrEvent>();
    for (const { event } of rows) {
      const address = addressOf(event);
      if (!seen.has(address)) {
        seen.add(address);
        current.add(event);
      }
    }
    let bytes = [...current].reduce((total, event) => total + sizeOf(event), 0);
    let truncated = false;
    const events = rows
      .map((row) => row.event)
      .filter((event) => {
        if (current.has(event)) {
          return true;
        }
        const size = sizeOf(event);
        if (truncated || bytes + size > maxBytes) {
          truncated = true;
          return false;
        }
        bytes += size;
        return true;
      });
    return { events, truncated };
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

  /**
   * Record that `holder`'s catalog sync started publishing, with its preview's diff, under
   * `syncId` (not the holder, which is nulled on release).
   */
  async startCatalogSync(
    owner: string,
    holder: string,
    syncId: string,
    diff: SyncDiff,
    now: number,
  ): Promise<void> {
    await this.db.query(
      `update catalog_syncs set state = 'running', diff = ($3::text)::jsonb, error = null,
         sync_id = $4, started_at = $5, finished_at = null
       where owner = $1 and holder = $2`,
      [owner, holder, JSON.stringify(diff), syncId, now],
    );
  }

  /**
   * Give the guard up at `now`, recording how the catalog sync ended when it ran one; a release
   * without `ended` (a dry run, a preview) leaves the row's status, id and times alone.
   */
  async releaseCatalogSync(
    owner: string,
    holder: string,
    now: number,
    ended?: CatalogSyncEnd,
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
         state = $3, diff = ($4::text)::jsonb, error = $5, finished_at = $6
       where owner = $1 and holder = $2`,
      [
        owner,
        holder,
        ended.state,
        JSON.stringify(ended.diff),
        ended.state === 'failed' ? ended.error : null,
        now,
      ],
    );
  }

  /** The store's last catalog sync; one still marked running that nobody holds was interrupted. */
  async catalogSync(owner: string, now: number): Promise<CatalogSyncStatus | null> {
    const [row] = await this.db.query<CatalogSyncRow>(
      `select holder, expires_at, state, diff, error, sync_id, started_at, finished_at
       from catalog_syncs where owner = $1`,
      [owner],
    );
    if (row === undefined || row.state === null || row.diff === null) {
      return null;
    }
    const times = {
      syncId: row.sync_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
    if (row.state === 'running') {
      const held = row.holder !== null && row.expires_at > now;
      return held
        ? { state: 'running', diff: row.diff, ...times }
        : { state: 'failed', diff: row.diff, error: SYNC_INTERRUPTED, ...times };
    }
    return row.state === 'done'
      ? { state: 'done', diff: row.diff, ...times }
      : { state: 'failed', diff: row.diff, error: row.error ?? 'unknown error', ...times };
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

  async disableConnector(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      'update connectors set enabled = false where owner = $1 returning 1',
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
