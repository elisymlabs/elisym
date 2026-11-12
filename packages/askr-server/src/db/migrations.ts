import type { Db } from './db';

/**
 * The schema (9), as plain SQL applied in order at startup and recorded in
 * `migrations`. Kept in a module rather than `.sql` files so the bundle carries
 * them. A migration is never edited once released; a change is a new entry.
 */
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_init',
    sql: `
create table tiers (
  name text primary key,
  messages_per_session_per_day integer not null check (messages_per_session_per_day > 0),
  daily_budget_usd numeric(20, 9) not null check (daily_budget_usd > 0),
  monthly_budget_usd numeric(20, 9) not null check (monthly_budget_usd > 0),
  tickets_per_store_per_minute integer not null check (tickets_per_store_per_minute > 0),
  max_products integer not null check (max_products > 0),
  sync_interval_minutes integer not null check (sync_interval_minutes > 0),
  branding boolean not null
);

create table stores (
  owner text primary key,
  status text not null check (status in ('pending', 'active', 'suspended')),
  tier text references tiers (name),
  assistant text not null unique,
  assistant_key bytea not null,
  catalog_key text not null unique,
  catalog_key_secret bytea not null,
  -- A rotation in progress (1.5): the new A, used once O signs a config naming it.
  next_assistant text unique,
  next_assistant_key bytea,
  created_at bigint not null,
  check (status = 'pending' or tier is not null)
);

-- O-signed events (30497, 30496, kind 5) stored by the admin and published once the store is active.
create table store_events (
  id text primary key,
  owner text not null references stores (owner) on delete cascade,
  event jsonb not null,
  published boolean not null default false,
  -- Publishes the relay explicitly refused (OK false); past the limit the event is no longer retried.
  publish_failures integer not null default 0,
  -- Failed publishes of any kind, the relay unreachable included: they set the backoff, never the stop.
  publish_attempts integer not null default 0,
  -- Unix seconds before which a failed event is not retried (backoff).
  next_attempt_at bigint not null default 0
);
create index store_events_unpublished on store_events (owner) where not published;

create table leases (
  owner text primary key references stores (owner) on delete cascade,
  holder text not null,
  epoch bigint not null,
  expires_at bigint not null
);

create table sessions (
  -- The store (O): a session keeps it when A rotates, so its attempts stay resolvable (1.5, 5.8).
  owner text not null,
  assistant text not null,
  visitor text not null,
  id text not null unique,
  session_end bigint not null,
  data jsonb not null,
  primary key (assistant, visitor)
);
create index sessions_end on sessions (session_end);

create table asks (
  session_id text not null references sessions (id) on delete cascade,
  ask_id text not null,
  state text not null check (state in ('queued', 'running', 'answered', 'failed')),
  attempt_id text not null,
  lease_epoch bigint not null,
  deadline bigint not null,
  answer_wrap jsonb,
  primary key (session_id, ask_id)
);
create index asks_attempt on asks (attempt_id);

create table store_days (
  owner text not null,
  day integer not null,
  spent numeric(20, 9) not null default 0,
  reserved numeric(20, 9) not null default 0,
  primary key (owner, day)
);

create table reservations (
  attempt_id text primary key,
  owner text not null,
  day integer not null,
  amount numeric(20, 9) not null,
  -- Unix seconds: a reservation no ask references past the turn deadline plus a margin is resolved by the sweep.
  created_at bigint not null,
  -- Set when the attempt's session ended while it was running: unix ms after which it is charged in full.
  orphan_deadline bigint
);
create index reservations_orphans on reservations (orphan_deadline) where orphan_deadline is not null;

create table session_days (
  assistant text not null,
  visitor text not null,
  day integer not null,
  used integer not null,
  primary key (assistant, visitor, day)
);

create table rumors (
  id text primary key,
  expires_at bigint not null
);
create index rumors_expiry on rumors (expires_at);

create table clicks (
  owner text not null,
  address text not null,
  count bigint not null,
  primary key (owner, address)
);

-- One platform connector per store (7.4); synced on the tier's interval once enabled after the preview.
create table connectors (
  owner text primary key references stores (owner) on delete cascade,
  platform text not null check (platform in ('shopify', 'woocommerce', 'google')),
  url text not null,
  currency text,
  import_policies boolean not null,
  enabled boolean not null default false,
  last_status jsonb,
  last_run_at bigint,
  next_run_at bigint
);

-- The admin's catalog sync and connector preview of a store, one at a time across instances (7.3, 7.4):
-- held while holder is set and expires_at (unix seconds, renewed while it runs) is ahead; the last
-- catalog sync's status for GET /store on any instance.
create table catalog_syncs (
  owner text primary key references stores (owner) on delete cascade,
  holder text,
  expires_at bigint not null default 0,
  state text check (state in ('running', 'done', 'failed')),
  diff jsonb,
  error text,
  started_at bigint
);

create table admin_auth_ids (
  id text primary key,
  expires_at bigint not null
);
create index admin_auth_ids_expiry on admin_auth_ids (expires_at);
`,
  },
];

const LOCK_ID = 7_301_995;

/** Apply every migration not applied yet, under an advisory lock so two starting servers do not race. */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    await tx.query(
      'create table if not exists migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    const applied = new Set(
      (await tx.query<{ id: string }>('select id from migrations')).map((row) => row.id),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) {
        continue;
      }
      await tx.script(migration.sql);
      await tx.query('insert into migrations (id) values ($1)', [migration.id]);
    }
  });
}
