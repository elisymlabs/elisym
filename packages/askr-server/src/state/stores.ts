import { KIND_CONFIG, parseConfig } from '@elisym/askr';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { type Db, STORES_CHANNEL } from '../db/db';
import type { KeyVault } from '../db/keys';
import { STORE_SELECT, monthStartDay, storeOf, utcDay } from './pg-state';
import type { StoreRecord, StoreStatus, Tier } from './types';

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

  async list(): Promise<{ owner: string; status: StoreStatus; tier: string | null }[]> {
    return this.db.query<{ owner: string; status: StoreStatus; tier: string | null }>(
      'select owner, status, tier from stores order by created_at',
    );
  }

  /**
   * Set a store's state (and tier on activation) and notify the running
   * server (7.3); false when there is no such store or tier.
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
         where owner = $1 and ($2 <> 'active' or coalesce($3, tier) is not null)
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
   * id is kept as is. A config naming the rotation's new A completes the
   * rotation in the same step (1.5), and the running server is notified.
   */
  async addEvents(owner: string, events: readonly NostrEvent[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const event of events) {
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
          `insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)
           on conflict (id) do nothing`,
          [event.id, owner, JSON.stringify(event)],
        );
      }
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
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

  /** Events of active stores not yet accepted by the relay, oldest first. */
  async unpublishedEvents(): Promise<{ owner: string; event: NostrEvent }[]> {
    return this.db.query<{ owner: string; event: NostrEvent }>(
      `select e.owner, e.event from store_events e join stores s on s.owner = e.owner
       where not e.published and s.status = 'active'
       order by (e.event->>'created_at')::bigint, e.id`,
    );
  }

  async markPublished(id: string): Promise<void> {
    await this.db.query('update store_events set published = true where id = $1', [id]);
  }
}
