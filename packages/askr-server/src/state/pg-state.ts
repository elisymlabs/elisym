import { SESSION_END_MARGIN_SECS, SESSION_TTL_SECS } from '@elisym/askr';
import type { LlmMessage } from '@elisym/askr-agent';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { ORPHAN_RESERVATION_SECS, RUMOR_DEDUP_SECS } from '../constants';
import type { Db, Queryable } from '../db/db';
import type { KeyVault } from '../db/keys';
import type {
  Admission,
  AskRecord,
  AskState,
  LeasedStore,
  ServerState,
  SessionState,
  StoreRecord,
  StoreStatus,
  Tier,
} from './types';

const SECS_PER_DAY = 24 * 60 * 60;

export function utcDay(now: number): number {
  return Math.floor(now / SECS_PER_DAY);
}

/** The UTC day number the calendar month of `now` starts on. */
export function monthStartDay(now: number): number {
  const date = new Date(now * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / (SECS_PER_DAY * 1000);
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The columns `STORE_SELECT` yields. */
interface StoreRow extends Record<string, unknown> {
  owner: string;
  status: StoreStatus;
  assistant: string;
  assistant_key: Uint8Array;
  catalog_key: string;
  catalog_key_secret: Uint8Array;
  tier: string | null;
  messages_per_session_per_day: number | null;
  daily_budget_usd: string | null;
  monthly_budget_usd: string | null;
  tickets_per_store_per_minute: number | null;
  max_products: number | null;
  sync_interval_minutes: number | null;
  branding: boolean | null;
}

const STORE_COLUMNS = `
  s.owner, s.status, s.assistant, s.assistant_key, s.catalog_key, s.catalog_key_secret, s.tier,
  t.messages_per_session_per_day, t.daily_budget_usd, t.monthly_budget_usd,
  t.tickets_per_store_per_minute, t.max_products, t.sync_interval_minutes, t.branding`;
const STORE_FROM = 'from stores s left join tiers t on t.name = s.tier';
export const STORE_SELECT = `select ${STORE_COLUMNS} ${STORE_FROM}`;

function tierOf(row: StoreRow): Tier | undefined {
  if (
    row.tier === null ||
    row.messages_per_session_per_day === null ||
    row.daily_budget_usd === null ||
    row.monthly_budget_usd === null ||
    row.tickets_per_store_per_minute === null ||
    row.max_products === null ||
    row.sync_interval_minutes === null ||
    row.branding === null
  ) {
    return undefined;
  }
  return {
    name: row.tier,
    messagesPerSessionPerDay: row.messages_per_session_per_day,
    dailyBudgetUsd: row.daily_budget_usd,
    monthlyBudgetUsd: row.monthly_budget_usd,
    ticketsPerStorePerMinute: row.tickets_per_store_per_minute,
    maxProducts: row.max_products,
    syncIntervalMinutes: row.sync_interval_minutes,
    branding: row.branding,
  };
}

export function storeOf(row: StoreRow, vault: KeyVault): StoreRecord {
  return {
    owner: row.owner,
    status: row.status,
    assistant: row.assistant,
    assistantSecretKey: vault.open(row.assistant_key, row.owner, 'assistant'),
    catalogKey: row.catalog_key,
    catalogSecretKey: vault.open(row.catalog_key_secret, row.owner, 'catalog'),
    tier: tierOf(row),
  };
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  owner: string;
  assistant: string;
  visitor: string;
  session_end: number;
  data: {
    history: LlmMessage[];
    visitorMessages: string[];
    policyPassages: string[];
    allowedIds: string[];
  };
}

function sessionOf(row: SessionRow): SessionState {
  return {
    id: row.id,
    owner: row.owner,
    assistant: row.assistant,
    visitor: row.visitor,
    sessionEnd: row.session_end,
    history: row.data.history,
    visitorMessages: row.data.visitorMessages,
    policyPassages: row.data.policyPassages,
    allowedIds: row.data.allowedIds,
  };
}

function newSession(owner: string, assistant: string, visitor: string, now: number): SessionState {
  return {
    id: randomId(),
    owner,
    assistant,
    visitor,
    sessionEnd: now + SESSION_TTL_SECS,
    history: [],
    visitorMessages: [],
    policyPassages: [],
    allowedIds: [],
  };
}

function sessionData(session: SessionState): string {
  return JSON.stringify({
    history: session.history,
    visitorMessages: session.visitorMessages,
    policyPassages: session.policyPassages,
    allowedIds: session.allowedIds,
  });
}

interface AskRow extends Record<string, unknown> {
  state: AskState;
  attempt_id: string;
  lease_epoch: number;
  deadline: number;
  answer_wrap: NostrEvent | null;
}

function askOf(row: AskRow): AskRecord {
  return {
    state: row.state,
    attemptId: row.attempt_id,
    leaseEpoch: row.lease_epoch,
    deadline: row.deadline,
    ...(row.answer_wrap ? { answerWrap: row.answer_wrap } : {}),
  };
}

/**
 * The `where` that makes a transition conditional on the store's current
 * lease epoch (5.8). By owner, not A: a rotation of A keeps the lease.
 */
function epochIsCurrent(ownerParam: string, epochParam: string): string {
  return `exists (select 1 from leases l where l.owner = ${ownerParam} and l.epoch = ${epochParam})`;
}

const SUPERSEDED: Admission = { admitted: false, reason: 'superseded' };

/**
 * The server state on Postgres (9). Money is read as `numeric` text, added
 * with `decimal.js-light` and written back under the store's day row lock, so
 * reservations of one store are serialized and the budget stays a bound.
 */
export class PgState implements ServerState {
  constructor(
    private readonly db: Db,
    private readonly vault: KeyVault,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async store(owner: string): Promise<StoreRecord | undefined> {
    const [row] = await this.db.query<StoreRow>(`${STORE_SELECT} where s.owner = $1`, [owner]);
    return row ? storeOf(row, this.vault) : undefined;
  }

  async acquireLeases(holder: string, now: number, ttlSecs: number): Promise<LeasedStore[]> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.query(
        `update leases set expires_at = 0
         where holder = $1 and owner in (select owner from stores where status <> 'active')`,
        [holder],
      );
      await tx.query(
        `insert into leases (owner, holder, epoch, expires_at)
         select owner, $1, 1, $3 from stores where status = 'active'
         on conflict (owner) do update set
           epoch = case when leases.holder = $1 and leases.expires_at > $2
             then leases.epoch else leases.epoch + 1 end,
           holder = $1,
           expires_at = $3
         where leases.holder = $1 or leases.expires_at <= $2`,
        [holder, now, now + ttlSecs],
      );
      return tx.query<StoreRow & { epoch: number }>(
        `select ${STORE_COLUMNS}, l.epoch ${STORE_FROM} join leases l on l.owner = s.owner
         where l.holder = $1 and l.expires_at > $2 and s.status = 'active'`,
        [holder, now],
      );
    });
    // One store whose keys do not open (a corrupted row, a wrong master key) never stops the others.
    return rows.flatMap((row) => {
      try {
        return [{ store: storeOf(row, this.vault), epoch: row.epoch }];
      } catch (error) {
        this.log(
          `store ${row.owner} skipped: its keys do not open (${error instanceof Error ? error.message : 'unknown'})`,
        );
        return [];
      }
    });
  }

  async releaseLeases(holder: string): Promise<void> {
    await this.db.query('update leases set expires_at = 0 where holder = $1', [holder]);
  }

  async session(
    owner: string,
    assistant: string,
    visitor: string,
    now: number,
  ): Promise<SessionState> {
    return this.db.transaction(async (tx) => {
      // Two first messages at once: one insert wins, the other waits for it and reads its row.
      await this.insertSession(tx, newSession(owner, assistant, visitor, now), 'do nothing');
      const [existing] = await tx.query<SessionRow>(
        'select * from sessions where assistant = $1 and visitor = $2 for update',
        [assistant, visitor],
      );
      if (existing && existing.session_end - now > SESSION_END_MARGIN_SECS) {
        return sessionOf(existing);
      }
      // A session ends 24 h after its first message and is deleted with its history (5.8).
      if (existing) {
        await this.dropSession(tx, existing.id);
      }
      const fresh = newSession(owner, assistant, visitor, now);
      await this.insertSession(tx, fresh, 'fail');
      return fresh;
    });
  }

  private async insertSession(
    tx: Queryable,
    session: SessionState,
    onConflict: 'do nothing' | 'fail',
  ): Promise<void> {
    await tx.query(
      `insert into sessions (owner, assistant, visitor, id, session_end, data)
       values ($1, $2, $3, $4, $5, ($6::text)::jsonb)
       ${onConflict === 'do nothing' ? 'on conflict (assistant, visitor) do nothing' : ''}`,
      [
        session.owner,
        session.assistant,
        session.visitor,
        session.id,
        session.sessionEnd,
        sessionData(session),
      ],
    );
  }

  async storedSession(assistant: string, visitor: string): Promise<SessionState | undefined> {
    const [row] = await this.db.query<SessionRow>(
      'select * from sessions where assistant = $1 and visitor = $2',
      [assistant, visitor],
    );
    return row ? sessionOf(row) : undefined;
  }

  async saveSession(session: SessionState): Promise<void> {
    await this.db.query('update sessions set data = ($2::text)::jsonb where id = $1', [
      session.id,
      sessionData(session),
    ]);
  }

  async rumorSeen(rumorId: string, now: number): Promise<boolean> {
    const rows = await this.db.query('select 1 from rumors where id = $1 and expires_at > $2', [
      rumorId,
      now,
    ]);
    return rows.length > 0;
  }

  async recordRumor(rumorId: string, now: number): Promise<boolean> {
    const rows = await this.db.query(
      `insert into rumors (id, expires_at) values ($1, $2)
       on conflict (id) do update set expires_at = $2 where rumors.expires_at <= $3
       returning 1`,
      [rumorId, now + RUMOR_DEDUP_SECS, now],
    );
    return rows.length > 0;
  }

  async askRecord(session: SessionState, askId: string): Promise<AskRecord | undefined> {
    const [row] = await this.db.query<AskRow>(
      'select * from asks where session_id = $1 and ask_id = $2',
      [session.id, askId],
    );
    return row ? askOf(row) : undefined;
  }

  /** A session's ask records are deleted with it; what their attempts hold is resolved first (5.8). */
  private async dropSession(tx: Queryable, sessionId: string): Promise<void> {
    const asks = await tx.query<AskRow>('select * from asks where session_id = $1', [sessionId]);
    for (const ask of asks) {
      if (ask.state === 'queued') {
        await this.settle(tx, ask.attempt_id, '0');
      } else if (ask.state === 'running') {
        // The finishing turn settles it with what it spent; one that never finishes is charged in full past its deadline.
        await tx.query('update reservations set orphan_deadline = $2 where attempt_id = $1', [
          ask.attempt_id,
          ask.deadline,
        ]);
      }
    }
    await tx.query('delete from sessions where id = $1', [sessionId]);
  }

  /** Lock the store's row for the day, creating it at zero. */
  private async lockDay(
    tx: Queryable,
    owner: string,
    day: number,
  ): Promise<{ spent: Decimal; reserved: Decimal }> {
    await tx.query(
      'insert into store_days (owner, day) values ($1, $2) on conflict (owner, day) do nothing',
      [owner, day],
    );
    const [row] = await tx.query<{ spent: string; reserved: string }>(
      'select spent, reserved from store_days where owner = $1 and day = $2 for update',
      [owner, day],
    );
    if (!row) {
      throw new Error('store day row missing');
    }
    return { spent: new Decimal(row.spent), reserved: new Decimal(row.reserved) };
  }

  /** What a store has spent and holds this month before today. */
  private async monthBeforeToday(tx: Queryable, owner: string, now: number): Promise<Decimal> {
    const rows = await tx.query<{ spent: string; reserved: string }>(
      'select spent, reserved from store_days where owner = $1 and day >= $2 and day < $3',
      [owner, monthStartDay(now), utcDay(now)],
    );
    return rows.reduce((total, row) => total.plus(row.spent).plus(row.reserved), new Decimal(0));
  }

  /**
   * Today's reservations of the store if one more `amount` fits its daily and
   * monthly budget, with today's row locked; undefined when it does not fit.
   */
  private async fits(
    tx: Queryable,
    owner: string,
    tier: Tier,
    amount: string,
    now: number,
  ): Promise<{ reserved: Decimal } | undefined> {
    const today = await this.lockDay(tx, owner, utcDay(now));
    const todayTotal = today.spent.plus(today.reserved).plus(amount);
    if (todayTotal.greaterThan(tier.dailyBudgetUsd)) {
      return undefined;
    }
    const month = (await this.monthBeforeToday(tx, owner, now)).plus(todayTotal);
    return month.greaterThan(tier.monthlyBudgetUsd) ? undefined : today;
  }

  /** Settle an attempt's reservation to actual spend (`reserved`: in full); a no-op once resolved. */
  private async settle(tx: Queryable, attemptId: string, spentUsd: string): Promise<void> {
    const [reservation] = await tx.query<{ owner: string; day: number; amount: string }>(
      'delete from reservations where attempt_id = $1 returning owner, day, amount',
      [attemptId],
    );
    if (!reservation) {
      return;
    }
    const day = await this.lockDay(tx, reservation.owner, reservation.day);
    const charged = spentUsd === 'reserved' ? reservation.amount : spentUsd;
    await tx.query(
      'update store_days set reserved = $3, spent = $4 where owner = $1 and day = $2',
      [
        reservation.owner,
        reservation.day,
        day.reserved.minus(reservation.amount).toString(),
        day.spent.plus(charged).toString(),
      ],
    );
  }

  /**
   * The quota, the budget and the reservation of a new attempt, all in `tx`;
   * a refusal writes nothing.
   */
  private async reserveAttempt(
    tx: Queryable,
    session: SessionState,
    reserveUsd: string,
    now: number,
  ): Promise<{ attemptId: string } | { reason: 'quota' | 'budget' }> {
    const [row] = await tx.query<StoreRow>(`${STORE_SELECT} where s.owner = $1 for update of s`, [
      session.owner,
    ]);
    const tier = row ? tierOf(row) : undefined;
    if (!row || row.status !== 'active' || tier === undefined) {
      return { reason: 'budget' };
    }
    const day = utcDay(now);
    const [quota] = await tx.query<{ used: number }>(
      `select used from session_days where assistant = $1 and visitor = $2 and day = $3 for update`,
      [session.assistant, session.visitor, day],
    );
    if ((quota?.used ?? 0) >= tier.messagesPerSessionPerDay) {
      return { reason: 'quota' };
    }
    const today = await this.fits(tx, row.owner, tier, reserveUsd, now);
    if (today === undefined) {
      return { reason: 'budget' };
    }
    await tx.query('update store_days set reserved = $3 where owner = $1 and day = $2', [
      row.owner,
      day,
      today.reserved.plus(reserveUsd).toString(),
    ]);
    const attemptId = randomId();
    await tx.query(
      'insert into reservations (attempt_id, owner, day, amount, created_at) values ($1, $2, $3, $4, $5)',
      [attemptId, row.owner, day, reserveUsd, now],
    );
    await tx.query(
      `insert into session_days (assistant, visitor, day, used) values ($1, $2, $3, 1)
       on conflict (assistant, visitor, day) do update set used = session_days.used + 1`,
      [session.assistant, session.visitor, day],
    );
    return { attemptId };
  }

  /** Lock the session row; false once it was replaced or swept. */
  private async lockSession(tx: Queryable, session: SessionState): Promise<boolean> {
    const rows = await tx.query('select 1 from sessions where id = $1 for update', [session.id]);
    return rows.length > 0;
  }

  /**
   * Whether `epoch` is the store's current lease epoch, holding the lease row
   * so a lease taken over meanwhile waits for this transaction (5.8).
   */
  private async leaseIsCurrent(tx: Queryable, owner: string, epoch: number): Promise<boolean> {
    const rows = await tx.query('select 1 from leases where owner = $1 and epoch = $2 for share', [
      owner,
      epoch,
    ]);
    return rows.length > 0;
  }

  async admitAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    epoch: number,
    now: number,
  ): Promise<Admission> {
    return this.db.transaction(async (tx) => {
      if (
        !(await this.lockSession(tx, session)) ||
        !(await this.leaseIsCurrent(tx, session.owner, epoch))
      ) {
        return SUPERSEDED;
      }
      // A record exists: another attempt owns the ask (a retry decides, never an overwrite).
      const existing = await tx.query('select 1 from asks where session_id = $1 and ask_id = $2', [
        session.id,
        askId,
      ]);
      if (existing.length > 0) {
        return SUPERSEDED;
      }
      const reserved = await this.reserveAttempt(tx, session, reserveUsd, now);
      if ('reason' in reserved) {
        return { admitted: false, reason: reserved.reason };
      }
      const { attemptId } = reserved;
      const inserted = await tx.query(
        `insert into asks (session_id, ask_id, state, attempt_id, lease_epoch, deadline)
         values ($1, $2, 'queued', $3, $4, 0)
         on conflict (session_id, ask_id) do nothing
         returning 1`,
        [session.id, askId, attemptId, epoch],
      );
      if (inserted.length === 0) {
        // Unreachable under the session lock; the throw rolls the reservation back.
        throw new Error('ask record appeared during admission');
      }
      return {
        admitted: true,
        record: { state: 'queued', attemptId, leaseEpoch: epoch, deadline: 0 },
      };
    });
  }

  async retryAsk(
    session: SessionState,
    askId: string,
    previousAttemptId: string,
    reserveUsd: string,
    epoch: number,
    now: number,
  ): Promise<Admission> {
    return this.db.transaction(async (tx) => {
      if (
        !(await this.lockSession(tx, session)) ||
        !(await this.leaseIsCurrent(tx, session.owner, epoch))
      ) {
        return SUPERSEDED;
      }
      const [previous] = await tx.query<AskRow>(
        'select * from asks where session_id = $1 and ask_id = $2 for update',
        [session.id, askId],
      );
      // Only the attempt the caller read is superseded; another retry got there first otherwise.
      if (!previous || previous.attempt_id !== previousAttemptId || previous.state === 'answered') {
        return SUPERSEDED;
      }
      const live =
        (previous.state === 'queued' || previous.state === 'running') &&
        previous.lease_epoch === epoch &&
        previous.deadline > now * 1000;
      if (live) {
        return SUPERSEDED;
      }
      const reserved = await this.reserveAttempt(tx, session, reserveUsd, now);
      if ('reason' in reserved) {
        return { admitted: false, reason: reserved.reason };
      }
      if (previous.state === 'queued') {
        await this.settle(tx, previous.attempt_id, '0');
      } else if (previous.state === 'running') {
        // Real usage is unknown: the superseded attempt is charged in full.
        await this.settle(tx, previous.attempt_id, 'reserved');
      }
      const { attemptId } = reserved;
      await tx.query(
        `update asks set state = 'queued', attempt_id = $3, lease_epoch = $4, deadline = 0, answer_wrap = null
         where session_id = $1 and ask_id = $2`,
        [session.id, askId, attemptId, epoch],
      );
      return {
        admitted: true,
        record: { state: 'queued', attemptId, leaseEpoch: epoch, deadline: 0 },
      };
    });
  }

  async startAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    deadline: number,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `update asks set state = 'running', deadline = $1
       where session_id = $2 and ask_id = $3 and state = 'queued'
         and attempt_id = $4 and lease_epoch = $5 and ${epochIsCurrent('$6', '$5')}
       returning 1`,
      [deadline, session.id, askId, attemptId, epoch, session.owner],
    );
    return rows.length > 0;
  }

  async answerAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    answerWrap: NostrEvent,
    spentUsd: string,
    now: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `update asks set state = 'answered', answer_wrap = ($1::text)::jsonb
         where session_id = $2 and ask_id = $3 and state = 'running'
           and attempt_id = $4 and lease_epoch = $5 and deadline > $6
           and ${epochIsCurrent('$7', '$5')}
         returning 1`,
        [
          JSON.stringify(answerWrap),
          session.id,
          askId,
          attemptId,
          epoch,
          now * 1000,
          session.owner,
        ],
      );
      if (rows.length === 0) {
        return false;
      }
      // The answer and the history it extends are one step: a crash never keeps one without the other.
      await tx.query('update sessions set data = ($2::text)::jsonb where id = $1', [
        session.id,
        sessionData(session),
      ]);
      await this.settle(tx, attemptId, spentUsd);
      return true;
    });
  }

  async failAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    spentUsd: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [reservation] = await tx.query<{ orphan_deadline: number | null }>(
        'select orphan_deadline from reservations where attempt_id = $1 for update',
        [attemptId],
      );
      if (reservation && reservation.orphan_deadline !== null) {
        // Its session is gone: settle what the turn spent, nothing to tell the visitor.
        await this.settle(tx, attemptId, spentUsd);
        return false;
      }
      const rows = await tx.query(
        `update asks set state = 'failed'
         where session_id = $1 and ask_id = $2 and state = 'running'
           and attempt_id = $3 and lease_epoch = $4 and ${epochIsCurrent('$5', '$4')}
         returning 1`,
        [session.id, askId, attemptId, epoch, session.owner],
      );
      if (rows.length === 0) {
        return false;
      }
      await this.settle(tx, attemptId, spentUsd);
      return true;
    });
  }

  async budgetExhausted(owner: string, now: number, reserveUsd: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<StoreRow>(`${STORE_SELECT} where s.owner = $1`, [owner]);
      const tier = row ? tierOf(row) : undefined;
      if (tier === undefined) {
        return true;
      }
      // The same test a reservation makes: no ticket when not even one turn's reservation fits.
      return (await this.fits(tx, owner, tier, reserveUsd, now)) === undefined;
    });
  }

  async countClick(owner: string, address: string): Promise<void> {
    await this.db.query(
      `insert into clicks (owner, address, count) values ($1, $2, 1)
       on conflict (owner, address) do update set count = clicks.count + 1`,
      [owner, address],
    );
  }

  /**
   * Attempts nobody will finish or retry (5.8): `queued` under a lease epoch
   * that is no longer current, or under a lease that has expired or was given
   * up (a suspended store's, whose epoch stays until someone takes it), is
   * released; `running` past its deadline is converted into spend in full;
   * both records become `failed`, so the next resend re-runs at once. Joined
   * by owner, so a rotation of A does not hide them.
   */
  private async resolveAbandoned(now: number): Promise<void> {
    const abandoned = await this.db.query<{ session_id: string; ask_id: string }>(
      `select a.session_id, a.ask_id from asks a
       join sessions se on se.id = a.session_id
       left join leases l on l.owner = se.owner
       where (a.state = 'running' and a.deadline <= $1)
          or (a.state = 'queued'
              and (l.epoch is null or l.epoch <> a.lease_epoch or l.expires_at <= $2))`,
      [now * 1000, now],
    );
    for (const { session_id: sessionId, ask_id: askId } of abandoned) {
      await this.db.transaction(async (tx) => {
        const [ask] = await tx.query<
          AskRow & { current_epoch: number | null; lease_expires_at: number | null }
        >(
          `select a.*, l.epoch as current_epoch, l.expires_at as lease_expires_at from asks a
           join sessions se on se.id = a.session_id
           left join leases l on l.owner = se.owner
           where a.session_id = $1 and a.ask_id = $2
           for update of a`,
          [sessionId, askId],
        );
        const pastDeadline = ask?.state === 'running' && ask.deadline <= now * 1000;
        const deadQueued =
          ask?.state === 'queued' &&
          (ask.current_epoch !== ask.lease_epoch ||
            ask.lease_expires_at === null ||
            ask.lease_expires_at <= now);
        if (!ask || !(pastDeadline || deadQueued)) {
          return;
        }
        await tx.query(`update asks set state = 'failed' where session_id = $1 and ask_id = $2`, [
          sessionId,
          askId,
        ]);
        await this.settle(tx, ask.attempt_id, deadQueued ? '0' : 'reserved');
      });
    }
  }

  async sweep(now: number): Promise<void> {
    const ended = await this.db.query<{ id: string }>(
      'select id from sessions where session_end <= $1',
      [now],
    );
    for (const { id } of ended) {
      await this.db.transaction(async (tx) => {
        const rows = await tx.query(
          'select 1 from sessions where id = $1 and session_end <= $2 for update',
          [id, now],
        );
        if (rows.length > 0) {
          await this.dropSession(tx, id);
        }
      });
    }
    await this.resolveAbandoned(now);
    const orphans = await this.db.query<{ attempt_id: string }>(
      'select attempt_id from reservations where orphan_deadline <= $1',
      [now * 1000],
    );
    for (const { attempt_id: attemptId } of orphans) {
      await this.db.transaction((tx) => this.settle(tx, attemptId, 'reserved'));
    }
    // Defense in depth: a reservation no ask references (never created so by design) is not held
    // until the daily reset. Its turn may have run, so it is charged in full.
    const unreferenced = await this.db.query<{ attempt_id: string }>(
      `select r.attempt_id from reservations r
       where r.orphan_deadline is null and r.created_at <= $1
         and not exists (select 1 from asks a where a.attempt_id = r.attempt_id)`,
      [now - ORPHAN_RESERVATION_SECS],
    );
    for (const { attempt_id: attemptId } of unreferenced) {
      this.log(`reservation ${attemptId} had no ask: charged in full`);
      await this.db.transaction((tx) => this.settle(tx, attemptId, 'reserved'));
    }
    await this.db.query('delete from rumors where expires_at <= $1', [now]);
    await this.db.query('delete from admin_auth_ids where expires_at <= $1', [now]);
    await this.db.query('delete from session_days where day < $1', [utcDay(now)]);
  }

  /** Test and admin view: a store's spend and reservations on the day of `now`. */
  async dayTotals(owner: string, now: number): Promise<{ spent: string; reserved: string }> {
    const [row] = await this.db.query<{ spent: string; reserved: string }>(
      'select spent, reserved from store_days where owner = $1 and day = $2',
      [owner, utcDay(now)],
    );
    return {
      spent: new Decimal(row?.spent ?? '0').toString(),
      reserved: new Decimal(row?.reserved ?? '0').toString(),
    };
  }

  async clicksFor(owner: string, address: string): Promise<number> {
    const [row] = await this.db.query<{ count: number }>(
      'select count from clicks where owner = $1 and address = $2',
      [owner, address],
    );
    return row?.count ?? 0;
  }
}
