import type { Db } from './db';

/**
 * The schema, as plain SQL applied in order at startup and recorded in
 * `paycore_migrations`. Kept in a module rather than `.sql` files so the bundle carries
 * them. A migration is never edited once released; a change is a new entry.
 */
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_init',
    sql: `
create table tiers (
  name text primary key,
  max_products integer not null check (max_products > 0)
);
create table stores (
  owner text primary key,                       -- O (R1: one store per O)
  store_pubkey text not null unique,            -- S
  status text not null check (status in ('pending','active','degraded','halted','suspending','suspended')),
  status_reason text,
  tier text references tiers (name),
  plan_source text check (plan_source in ('operator')),
  suspending_since bigint,
  created_at bigint not null,
  check (status = 'pending' or tier is not null)
);
create table store_keys (
  owner text primary key references stores (owner) on delete cascade,
  store_key bytea not null,                     -- AD paycore:store:<O>
  webhook_secret bytea,                         -- AD paycore:webhook:<O>
  webhook_rotated_at bigint
);
create table store_config (
  owner text primary key references stores (owner) on delete cascade,
  name text not null,
  nip05 text,
  network text not null check (network in ('mainnet','devnet')),
  draft_payouts jsonb not null default '[]',    -- P9: the draft; active = the ledger's state.payto
  evm_credit text not null default 'fast' check (evm_credit in ('fast','safe')),
  webhook_url text,
  inbox_relays text[] not null,                 -- P7: from the allowlist; ACTIVE (the node listens and replies there)
  draft_inbox_relays text[],                    -- the merchant's edit; active once its 10050 went out (null: none)
  revision bigint not null default 1,
  updated_at bigint not null
);
create table products (
  owner text not null references stores (owner) on delete cascade,
  d text not null,
  title text not null,
  description text not null,
  summary text,
  url text,
  price_usd text not null,
  on_sale boolean not null,
  updated_at bigint not null,
  primary key (owner, d)
);
create table owner_event_drafts (
  owner text not null references stores (owner) on delete cascade,
  kind integer not null check (kind in (10133, 30490)),
  template jsonb not null,
  payouts_string text,                          -- 10133 only: the exact draft string it was built from (P9)
  expires_at bigint not null,
  primary key (owner, kind),
  check (kind <> 10133 or payouts_string is not null)
);
create table owner_events (
  id text primary key,
  owner text not null references stores (owner) on delete cascade,
  kind integer not null check (kind in (10133, 30490)),
  event jsonb not null,
  payouts_string text,                          -- 10133 only: carried from the draft (P9)
  committed_at bigint not null,
  recorded boolean not null default false,      -- terms recorded in the ledger by the holder (first publish = setup pass)
  published_at bigint,
  publish_attempts integer not null default 0,
  next_attempt_at bigint not null default 0,
  check (kind <> 10133 or payouts_string is not null)
);
create index owner_events_latest on owner_events (owner, kind, committed_at desc);
create index owner_events_republish on owner_events (next_attempt_at) where recorded and published_at is null;
create table ledgers (
  owner text primary key references stores (owner) on delete cascade,
  row_version bigint not null,                  -- the fence; not LedgerState.version
  lease_epoch bigint not null,
  state text not null,                          -- LedgerState as JSON text (with the webhook outbox): jsonb refuses the NUL escape and lone surrogates a buyer can send
  updated_at bigint not null
);
create table leases (
  owner text primary key references stores (owner) on delete cascade,
  holder text not null,
  epoch bigint not null,
  expires_at bigint not null
);
create table admin_auth_ids (id text primary key, expires_at bigint not null);
create index admin_auth_ids_expiry on admin_auth_ids (expires_at);
create table admin_requests (
  id text primary key,
  owner text not null references stores (owner) on delete cascade,
  kind text not null check (kind in ('setup','record_owner_event','hand_answer','restart','suspend')),
  payload text not null,                       -- JSON as text: a buyer-chosen order id may hold a NUL escape jsonb refuses
  state text not null default 'pending' check (state in ('pending','applied','failed')),
  result text,                                  -- JSON as text; never holds a secret
  created_at bigint not null,
  applied_at bigint
);
create index admin_requests_pending on admin_requests (owner, created_at) where state = 'pending';
create table alerts (
  id bigserial primary key,
  owner text,
  kind text not null,
  message text not null,
  created_at bigint not null,
  last_seen_at bigint not null,
  count integer not null default 1,
  cleared_at bigint
);
create unique index alerts_open on alerts (coalesce(owner, ''), kind) where cleared_at is null;
`,
  },
];

const LOCK_ID = 7_302_101;

/** Apply every migration not applied yet, under an advisory lock so two starting servers do not race. */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    await tx.query(
      'create table if not exists paycore_migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    const applied = new Set(
      (await tx.query<{ id: string }>('select id from paycore_migrations')).map((row) => row.id),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) {
        continue;
      }
      await tx.script(migration.sql);
      await tx.query('insert into paycore_migrations (id) values ($1)', [migration.id]);
    }
  });
}
