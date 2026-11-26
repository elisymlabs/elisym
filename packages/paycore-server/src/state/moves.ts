/**
 * Moving a hosted store to a new owner key (O -> O', two keys, D1): the store
 * key S stays, so orders, payments, the ledger and carts keep pointing at the
 * same store. Prepare builds O''s payout list (10133) and hosted authorization
 * (30490) from wallet proofs for O' of every active payout (D4), and O's
 * revocation of its 30490 when O ever published one; commit takes those
 * events signed (O' and O) and rekeys every row of the store to O' in one
 * transaction. The store keeps selling on O's terms until a setup pass gets
 * O''s 10133 and 30490 out and then a profile naming O' (`switched_at`);
 * only then is O's 30490 revoked (the publisher).
 */
import { KIND_PAYTO, KIND_STORE_AUTH, buildStoreRevocationEvent } from '@elisym/commerce';
import { clockProblem } from '@merchant-node/setup-ledger';
import { ownerEventTemplates } from '@merchant-node/store-events';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { insertRequest } from '../admin/requests';
import { ALERT_KINDS } from '../alerts';
import { type Db, type Queryable, STORES_CHANNEL } from '../db/db';
import { WINDING_DOWN_STATUSES, activePayouts } from '../node/load';
import { DRAFT_TTL_SECS, SignedEventSchema, sameTemplate } from '../owner-events';
import type { StoreStatus } from './leases';
import { parseLedger } from './ledger-store';
import { isSwitching, lockOwnerKey } from './move-rows';
import { type Payout, type StoreDirectory, canonicalPayouts } from './stores';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;
const DEADLOCK = '40P01';
const UNIQUE_VIOLATION = '23505';

export type MoveError =
  | 'no_store'
  | 'moved'
  | 'taken'
  | 'key_in_use'
  | 'busy'
  | 'stale'
  | 'switching'
  | 'payouts_differ'
  | 'no_payouts'
  | 'bad_payouts'
  | 'suspended'
  | 'clock'
  | 'no_draft'
  | 'expired'
  | 'mismatch'
  | 'malformed'
  | 'signature'
  | 'author';

export interface MoveRefusal {
  ok: false;
  error: MoveError;
  problems?: string[];
  message?: string;
}

export interface MoveDeps {
  db: Db;
  directory: StoreDirectory;
  /** PAYCORE_OPERATOR: the new 30490 `operator` (R2). */
  operator: string;
  /** Seconds. */
  now: () => number;
  /** Where the `moved` alert's structured line goes (default: stderr). */
  log?: (line: string) => void;
}

/**
 * What the offer relays served, read before any transaction (a read may wait
 * seconds): the transaction compares only these values and committed rows.
 */
export interface MoveRelayFacts {
  /** `created_at` of the newest 10133 by the new key (undefined: none, or not read). */
  newestPaytoByTo?: number;
  /** `created_at` of O's newest 30490 at the store's address (undefined: none, or not read). */
  newestAuthByOwner?: number;
}

export interface MoveTemplates {
  to: string;
  /** O''s payout list, unsigned: signed by O'. */
  payto: EventTemplate;
  /** O''s hosted authorization, unsigned: signed by O'. */
  auth: EventTemplate;
  /** O's revocation of its authorization, unsigned: signed by O; null when O never published one. */
  revocation: EventTemplate | null;
  expiresAt: number;
}

export type PrepareMoveResult = ({ ok: true } & MoveTemplates) | MoveRefusal;

export interface MoveInput {
  to: string;
  payto: unknown;
  auth: unknown;
  revocation?: unknown;
}

export type MoveResult =
  | {
      ok: true;
      /** The same move committed before (the same new key): nothing was written now. */
      alreadyMoved: boolean;
      owner: string;
      storePubkey: string;
      pending: boolean;
      /** Whether buyers are still told of the former owner (the switch is to come). */
      switching: boolean;
      /** The setup request the move queued (none for a pending store). */
      requestId: string | undefined;
    }
  | MoveRefusal;

const WINDING_DOWN: MoveRefusal = {
  ok: false,
  error: 'suspended',
  message: 'the store is suspended or being suspended: it cannot move',
};

const SWITCHING: MoveRefusal = {
  ok: false,
  error: 'switching',
  message: 'the store is still switching to its last new owner key',
};

/** Whether `value` names a possible owner key (64 lowercase hex). */
export function isOwnerKey(value: unknown): value is string {
  return typeof value === 'string' && HEX_KEY_RE.test(value);
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function refuse(error: MoveError, extra: Omit<MoveRefusal, 'ok' | 'error'> = {}): MoveRefusal {
  return { ok: false, error, ...extra };
}

function parsedJson<Value>(value: Value | string): Value {
  return typeof value === 'string' ? (JSON.parse(value) as Value) : value;
}

/** Whether two payout lists pay the same (coin, address) pairs, signatures aside. */
export function samePayoutSet(
  left: readonly Pick<Payout, 'caip19' | 'address'>[],
  right: readonly Pick<Payout, 'caip19' | 'address'>[],
): boolean {
  const pairs = (list: readonly Pick<Payout, 'caip19' | 'address'>[]) =>
    new Set(list.map((payout) => JSON.stringify([payout.caip19, payout.address])));
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  return leftPairs.size === rightPairs.size && [...leftPairs].every((pair) => rightPairs.has(pair));
}

/** Whether `to` cannot take a store: it has one, it moved one away, or it is a store key. */
async function keyTaken(tx: Queryable, to: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from stores where owner = $1 or store_pubkey = $1
     union all select 1 from store_moves where from_owner = $1 limit 1`,
    [to],
  );
  return rows.length > 0;
}

/**
 * The payouts the move must carry over (D4): the active list buyers read
 * (`state.payto`), or the draft for a store never activated.
 */
function payoutsToCarry(
  state: ReturnType<typeof parseLedger>,
  draftPayouts: readonly Payout[],
  owner: string,
): Pick<Payout, 'caip19' | 'address'>[] {
  return state.payto === undefined ? [...draftPayouts] : activePayouts(state, owner);
}

/** O's committed authorizations: the newest date, and whether one was ever recorded or published. */
async function ownerAuthorizations(
  tx: Queryable,
  owner: string,
): Promise<{ newest: number | undefined; wentOut: boolean }> {
  const [row] = await tx.query<{ newest: number | null; went_out: boolean | null }>(
    `select max((event->>'created_at')::bigint) as newest,
       bool_or(recorded or published_at is not null) as went_out
     from owner_events where owner = $1 and kind = $2`,
    [owner, KIND_STORE_AUTH],
  );
  return { newest: row?.newest ?? undefined, wentOut: row?.went_out === true };
}

interface LockedStore extends Record<string, unknown> {
  status: StoreStatus;
  store_pubkey: string;
}

/**
 * Prepare a move of `owner`'s store to `input.to`: the payouts, proven for
 * the new key, must be exactly the active ones (D4); the templates to sign
 * are kept as the store's move draft for `DRAFT_TTL_SECS`. O''s payout list
 * is dated after the active one (a same-second list would be refused by the
 * setup pass) and after any the relays serve by the new key; O's revocation,
 * when O ever published an authorization, after every one of O's.
 */
export async function prepareMove(
  deps: MoveDeps,
  owner: string,
  input: { to: string; payouts: unknown },
  relays: MoveRelayFacts = {},
): Promise<PrepareMoveResult> {
  const { db, directory } = deps;
  const now = deps.now();
  const { to } = input;
  return db.transaction(async (tx): Promise<PrepareMoveResult> => {
    const [moved] = await tx.query('select 1 from store_moves where from_owner = $1', [owner]);
    if (moved !== undefined) {
      return refuse('moved');
    }
    const [store] = await tx.query<LockedStore>(
      'select status, store_pubkey from stores where owner = $1 for update',
      [owner],
    );
    const settings = await directory.settings(owner, tx);
    const state = await directory.ledgerState(owner, tx);
    if (store === undefined || settings === undefined || state === undefined) {
      return refuse('no_store');
    }
    if (WINDING_DOWN_STATUSES.includes(store.status)) {
      return WINDING_DOWN;
    }
    if (await isSwitching(tx, store.store_pubkey)) {
      return SWITCHING;
    }
    if (to === owner || (await keyTaken(tx, to))) {
      return refuse('taken');
    }
    if (relays.newestPaytoByTo !== undefined) {
      return refuse('key_in_use');
    }
    const carried = payoutsToCarry(state, settings.draftPayouts, owner);
    if (carried.length === 0) {
      return refuse('no_payouts');
    }
    const checked = directory.checkMovePayouts(
      to,
      settings,
      input.payouts,
      await directory.products(owner, tx),
    );
    if (checked.payouts === undefined) {
      return refuse('bad_payouts', { problems: checked.problems });
    }
    if (!samePayoutSet(checked.payouts.list, carried)) {
      return refuse('payouts_differ');
    }
    const paytoDate = Math.max(
      now,
      (relays.newestPaytoByTo ?? 0) + 1,
      (state.payto?.createdAt ?? 0) + 1,
    );
    const auths = await ownerAuthorizations(tx, owner);
    const needsRevocation = auths.wentOut || relays.newestAuthByOwner !== undefined;
    const revocationAfter = Math.max(auths.newest ?? 0, relays.newestAuthByOwner ?? 0);
    const revocationDate = Math.max(now, revocationAfter + 1);
    const problem =
      clockProblem('the payout list', paytoDate, now) ??
      (needsRevocation ? clockProblem('the store authorization', revocationDate, now) : undefined);
    if (problem !== undefined) {
      return refuse('clock', { message: problem });
    }
    let templates: ReturnType<typeof ownerEventTemplates>;
    try {
      templates = ownerEventTemplates(
        { payouts: checked.payouts.list },
        to,
        store.store_pubkey,
        paytoDate,
        paytoDate,
        { mode: 'hosted', operator: deps.operator },
      );
    } catch {
      return refuse('bad_payouts');
    }
    const revocation = needsRevocation
      ? buildStoreRevocationEvent(store.store_pubkey, revocationDate)
      : null;
    const expiresAt = now + DRAFT_TTL_SECS;
    await tx.query(
      `insert into store_move_drafts (owner, to_owner, payto, payouts_string, auth, revocation,
         revocation_after, expires_at)
       values ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7, $8)
       on conflict (owner) do update set to_owner = $2, payto = $3::jsonb, payouts_string = $4,
         auth = $5::jsonb, revocation = $6::jsonb, revocation_after = $7, expires_at = $8`,
      [
        owner,
        to,
        JSON.stringify(templates.payoutList),
        checked.payouts.text,
        JSON.stringify(templates.authorization),
        revocation === null ? null : JSON.stringify(revocation),
        needsRevocation ? revocationAfter : null,
        expiresAt,
      ],
    );
    return {
      ok: true,
      to,
      payto: templates.payoutList,
      auth: templates.authorization,
      revocation,
      expiresAt,
    };
  });
}

/** A signed event by `author`, or why not. */
function signedBy(raw: unknown, author: string): NostrEvent | 'malformed' | 'signature' | 'author' {
  const parsed = SignedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return 'malformed';
  }
  const event: NostrEvent = parsed.data;
  if (!verifyEvent(event)) {
    return 'signature';
  }
  return event.pubkey === author ? event : 'author';
}

interface SignedMove {
  payto: NostrEvent;
  auth: NostrEvent;
  revocation: NostrEvent | undefined;
}

function signedMove(owner: string, input: MoveInput): SignedMove | MoveRefusal {
  const payto = signedBy(input.payto, input.to);
  const auth = signedBy(input.auth, input.to);
  const revocation =
    input.revocation === undefined || input.revocation === null
      ? undefined
      : signedBy(input.revocation, owner);
  if (typeof payto === 'string') {
    return refuse(payto);
  }
  if (typeof auth === 'string') {
    return refuse(auth);
  }
  if (typeof revocation === 'string') {
    return refuse(revocation);
  }
  return { payto, auth, revocation };
}

interface DraftRow extends Record<string, unknown> {
  to_owner: string;
  payto: EventTemplate | string;
  payouts_string: string;
  auth: EventTemplate | string;
  revocation: EventTemplate | string | null;
  expires_at: number;
}

/**
 * Commit the move of `owner`'s store to `input.to`: the events signed, each
 * byte-equal to the move draft, by the new key (10133, 30490) and by O (the
 * revocation). One transaction, retried once on a deadlock: the store's rows
 * all become O''s (the foreign keys cascade), its secrets are resealed for
 * O', O's owner events are kept in `old_events` and O''s are committed
 * unrecorded, and a setup request is queued (unless the store is pending).
 * The same move again answers `alreadyMoved`; a move to another key, `moved`.
 */
export async function moveStore(
  deps: MoveDeps,
  owner: string,
  input: MoveInput,
  relays: MoveRelayFacts = {},
): Promise<MoveResult> {
  const signed = signedMove(owner, input);
  if ('ok' in signed) {
    return signed;
  }
  const attempt = () => commitMove(deps, owner, input.to, signed, relays);
  try {
    try {
      return await attempt();
    } catch (error) {
      if (pgCode(error) !== DEADLOCK) {
        throw error;
      }
      return await attempt();
    }
  } catch (error) {
    // Defense in depth behind the advisory locks: a key that got a store between the checks and the writes.
    if (pgCode(error) === UNIQUE_VIOLATION) {
      return refuse('taken');
    }
    throw error;
  }
}

async function commitMove(
  deps: MoveDeps,
  owner: string,
  to: string,
  signed: SignedMove,
  relays: MoveRelayFacts,
): Promise<MoveResult> {
  const { db, directory } = deps;
  const now = deps.now();
  return db.transaction(async (tx): Promise<MoveResult> => {
    // 1. Both keys, in one order: a creation or import of either waits, and two opposite moves never deadlock.
    for (const key of [owner, to].sort()) {
      await lockOwnerKey(tx, key);
    }
    const [done] = await tx.query<{ to_owner: string; store_pubkey: string }>(
      'select to_owner, store_pubkey from store_moves where from_owner = $1',
      [owner],
    );
    if (done !== undefined) {
      return done.to_owner === to ? alreadyMoved(tx, owner, done.store_pubkey) : refuse('moved');
    }
    // 2. The rows a holder's save locks, in its order: the store, its ledger, its requests, its events.
    const [store] = await tx.query<LockedStore>(
      'select status, store_pubkey from stores where owner = $1 for update',
      [owner],
    );
    const [ledger] = await tx.query<{ state: string }>(
      'select state from ledgers where owner = $1 for update',
      [owner],
    );
    const requests = await tx.query<{ kind: string; state: string }>(
      'select kind, state from admin_requests where owner = $1 for update',
      [owner],
    );
    const events = await tx.query<{
      kind: number;
      created_at: number;
      recorded: boolean;
      published_at: number | null;
    }>(
      `select kind, (event->>'created_at')::bigint as created_at, recorded, published_at
       from owner_events where owner = $1 for update`,
      [owner],
    );
    const settings = await directory.settings(owner, tx);
    if (store === undefined || ledger === undefined || settings === undefined) {
      return refuse('no_store');
    }
    const state = parseLedger(ledger.state, owner);
    const pending = store.status === 'pending';
    // 3. Whether a profile naming O can be on the relays, before O's owner events are deleted below.
    const [recorded] = await tx.query<{ any: boolean }>(
      'select exists (select 1 from owner_events where owner = $1 and recorded) as any',
      [owner],
    );
    const preSwitch = pending || (state.payto === undefined && recorded?.any !== true);
    // 4. The refusals, against committed rows and the relay facts read before the transaction.
    if (WINDING_DOWN_STATUSES.includes(store.status)) {
      return WINDING_DOWN;
    }
    if (await isSwitching(tx, store.store_pubkey)) {
      return SWITCHING;
    }
    if (to === owner || (await keyTaken(tx, to))) {
      return refuse('taken');
    }
    if (relays.newestPaytoByTo !== undefined) {
      return refuse('key_in_use');
    }
    const [draft] = await tx.query<DraftRow>(
      `select to_owner, payto, payouts_string, auth, revocation, expires_at
       from store_move_drafts where owner = $1`,
      [owner],
    );
    if (draft === undefined || draft.to_owner !== to) {
      return refuse('no_draft');
    }
    if (draft.expires_at <= now) {
      return refuse('expired');
    }
    const revocationTemplate =
      draft.revocation === null ? undefined : parsedJson<EventTemplate>(draft.revocation);
    const matches =
      sameTemplate(signed.payto, parsedJson<EventTemplate>(draft.payto), to) &&
      sameTemplate(signed.auth, parsedJson<EventTemplate>(draft.auth), to) &&
      (revocationTemplate === undefined
        ? signed.revocation === undefined
        : signed.revocation !== undefined &&
          sameTemplate(signed.revocation, revocationTemplate, owner));
    if (!matches) {
      return refuse('mismatch');
    }
    const auths = events.filter((event) => event.kind === KIND_STORE_AUTH);
    const authWentOut =
      auths.some((event) => event.recorded || event.published_at !== null) ||
      relays.newestAuthByOwner !== undefined;
    const newestAuth = Math.max(
      ...auths.map((event) => event.created_at),
      relays.newestAuthByOwner ?? 0,
    );
    if (
      signed.revocation === undefined ? authWentOut : newestAuth >= signed.revocation.created_at
    ) {
      return refuse('stale');
    }
    if (!pending && requests.some((request) => request.state === 'pending')) {
      return refuse('busy');
    }
    const carried = payoutsToCarry(state, settings.draftPayouts, owner);
    const proven = canonicalPayouts(JSON.parse(draft.payouts_string));
    if (carried.length === 0 || proven === undefined) {
      return refuse('no_payouts');
    }
    if (!samePayoutSet(proven.list, carried)) {
      return refuse('payouts_differ');
    }
    // A list dated at or before the active one would be refused by every setup pass: the store would never switch.
    if (state.payto !== undefined && signed.payto.created_at <= state.payto.createdAt) {
      return refuse('stale');
    }
    if (pending) {
      // Owner events O committed while pending are replaced by O''s: never recorded now.
      await tx.query(
        `update admin_requests set state = 'failed', applied_at = $2, result = $3
         where owner = $1 and kind = 'record_owner_event' and state = 'pending'`,
        [owner, now, JSON.stringify({ problem: 'superseded' })],
      );
    }
    // 5. The secrets' associated data names the owner.
    await directory.resealKeys(tx, owner, to);
    // 6. O's owner events leave with O.
    const [old] = await tx.query<{ rows: unknown }>(
      `select coalesce(jsonb_agg(to_jsonb(e) order by e.committed_at, e.id), '[]'::jsonb) as rows
       from owner_events e where e.owner = $1`,
      [owner],
    );
    await tx.query('delete from owner_events where owner = $1', [owner]);
    await tx.query('delete from owner_event_drafts where owner = $1', [owner]);
    await tx.query('delete from store_move_drafts where owner = $1', [owner]);
    // 7. Every child row follows (on update cascade); the lease keeps its holder and epoch.
    await tx.query('update stores set owner = $2 where owner = $1', [owner, to]);
    await tx.query('update alerts set owner = $2 where owner = $1', [owner, to]);
    await tx.query(
      `update alerts set cleared_at = $3 where owner = $1 and kind = $2 and cleared_at is null`,
      [to, ALERT_KINDS.drift, now],
    );
    // 8. O''s events, committed and unrecorded: the setup pass publishes them first.
    for (const event of [signed.payto, signed.auth]) {
      await tx.query(
        `insert into owner_events (id, owner, kind, event, payouts_string, committed_at)
         values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          event.id,
          to,
          event.kind,
          JSON.stringify(event),
          event.kind === KIND_PAYTO ? draft.payouts_string : null,
          now,
        ],
      );
    }
    await tx.query(
      `update store_config set draft_payouts = $2::jsonb, revision = revision + 1, updated_at = $3
       where owner = $1`,
      [to, draft.payouts_string, now],
    );
    const requestId = pending
      ? undefined
      : await insertRequest(tx, to, 'setup', moveRequestPayload(owner), now);
    // 9. The move, and its alert on O (O moves once: one row per move).
    await tx.query(
      `insert into store_moves (from_owner, to_owner, store_pubkey, moved_at, switched_at, revocation,
         old_events)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        owner,
        to,
        store.store_pubkey,
        now,
        preSwitch ? now : null,
        signed.revocation === undefined ? null : JSON.stringify(signed.revocation),
        JSON.stringify(old?.rows ?? []),
      ],
    );
    const message = `the store ${store.store_pubkey} moved to the owner key ${to}`;
    await tx.query(
      `insert into alerts (owner, kind, message, created_at, last_seen_at) values ($1, $2, $3, $4, $4)`,
      [owner, ALERT_KINDS.moved, message, now],
    );
    (deps.log ?? ((line: string) => console.error(line)))(
      JSON.stringify({ alert: ALERT_KINDS.moved, owner, message }),
    );
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, to]);
    return {
      ok: true,
      alreadyMoved: false,
      owner: to,
      storePubkey: store.store_pubkey,
      pending,
      switching: !preSwitch,
      requestId,
    };
  });
}

/** The payload of the setup request a move queues: names the move, so a repeat finds it. */
function moveRequestPayload(from: string): { moveFrom: string } {
  return { moveFrom: from };
}

/** The answer to the same move again: the store as it is now, and the setup request the move queued. */
async function alreadyMoved(tx: Queryable, from: string, storePubkey: string): Promise<MoveResult> {
  const [store] = await tx.query<{ owner: string; status: StoreStatus }>(
    'select owner, status from stores where store_pubkey = $1',
    [storePubkey],
  );
  if (store === undefined) {
    return refuse('no_store');
  }
  const [request] = await tx.query<{ id: string }>(
    `select id from admin_requests where owner = $1 and kind = 'setup' and payload = $2
     order by created_at, id limit 1`,
    [store.owner, JSON.stringify(moveRequestPayload(from))],
  );
  return {
    ok: true,
    alreadyMoved: true,
    owner: store.owner,
    storePubkey,
    pending: store.status === 'pending',
    switching: await isSwitching(tx, storePubkey),
    requestId: request?.id,
  };
}
