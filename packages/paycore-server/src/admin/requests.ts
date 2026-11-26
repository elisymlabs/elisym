import { randomBytes } from 'node:crypto';
import { type Queryable, REQUESTS_CHANNEL } from '../db/db';

/** How long an admin route waits for the holder to apply its request before answering 202. */
export const REQUEST_WAIT_MS = 10_000;
/** How often a waiting route reads its request again. */
export const REQUEST_POLL_MS = 250;

export type RequestKind = 'setup' | 'record_owner_event' | 'hand_answer' | 'restart' | 'suspend';
export type RequestState = 'pending' | 'applied' | 'failed';

/** An `admin_requests` row, its JSON parsed. */
export interface AdminRequest {
  id: string;
  owner: string;
  kind: RequestKind;
  payload: unknown;
  state: RequestState;
  /** What the holder recorded when it applied or failed it; never a secret. */
  result: unknown;
  createdAt: number;
  appliedAt: number | undefined;
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  owner: string;
  kind: RequestKind;
  payload: string;
  state: RequestState;
  result: string | null;
  created_at: number;
  applied_at: number | null;
}

let sequence = 0;

/**
 * A request id that sorts in creation order within this process: the
 * millisecond, a counter, then randomness. Rows of one second are drained in
 * id order, so two requests of the same click stay in order.
 */
export function newRequestId(nowMs: number = Date.now()): string {
  sequence = (sequence + 1) % 0x10000;
  return `${nowMs.toString(16).padStart(12, '0')}${sequence.toString(16).padStart(4, '0')}${randomBytes(8).toString('hex')}`;
}

function rowToRequest(row: RequestRow): AdminRequest {
  return {
    id: row.id,
    owner: row.owner,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    state: row.state,
    result: row.result === null ? undefined : JSON.parse(row.result),
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

const COLUMNS = 'id, owner, kind, payload, state, result, created_at, applied_at';

/**
 * Queue a request in `tx` and notify the owner's holder: the notify is sent
 * when `tx` commits (Postgres holds it until then), never for a rolled-back row.
 * The payload is JSON text (a buyer-chosen order id may hold a NUL escape).
 */
export async function insertRequest(
  tx: Queryable,
  owner: string,
  kind: RequestKind,
  payload: unknown,
  now: number,
): Promise<string> {
  const id = newRequestId();
  await tx.query(
    `insert into admin_requests (id, owner, kind, payload, created_at) values ($1, $2, $3, $4, $5)`,
    [id, owner, kind, JSON.stringify(payload), now],
  );
  await tx.query('select pg_notify($1, $2)', [REQUESTS_CHANNEL, owner]);
  return id;
}

/** A request by id, only when it is `owner`'s. */
export async function getRequest(
  db: Queryable,
  owner: string,
  id: string,
): Promise<AdminRequest | undefined> {
  const [row] = await db.query<RequestRow>(
    `select ${COLUMNS} from admin_requests where id = $1 and owner = $2`,
    [id, owner],
  );
  return row === undefined ? undefined : rowToRequest(row);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * The request once the holder applied or failed it, or `undefined` when it is
 * still pending after `timeoutMs` (the route answers 202 with its id). Read
 * again every `pollMs`: the holder marks a request in the ledger's save
 * transaction, which notifies no one.
 */
export async function waitResult(
  db: Queryable,
  owner: string,
  id: string,
  timeoutMs: number,
  options: { pollMs?: number; signal?: AbortSignal; clock?: () => number } = {},
): Promise<AdminRequest | undefined> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + timeoutMs;
  const pollMs = options.pollMs ?? REQUEST_POLL_MS;
  for (;;) {
    const request = await getRequest(db, owner, id);
    if (request === undefined || request.state !== 'pending') {
      return request;
    }
    const left = deadline - clock();
    if (left <= 0 || options.signal?.aborted === true) {
      return undefined;
    }
    await delay(Math.min(pollMs, left), options.signal);
  }
}

/**
 * Mark a request with no ledger change applied (or failed), after its effect.
 * Its effect must be idempotent: a crash before this mark applies it again.
 * False when it was no longer pending.
 */
export async function markRequest(
  db: Queryable,
  owner: string,
  id: string,
  state: 'applied' | 'failed',
  now: number,
  result?: unknown,
): Promise<boolean> {
  const rows = await db.query(
    `update admin_requests set state = $3, applied_at = $4, result = $5
     where id = $1 and owner = $2 and state = 'pending' returning 1`,
    [id, owner, state, now, result === undefined ? null : JSON.stringify(result)],
  );
  return rows.length > 0;
}

/** The owner's pending requests, oldest first. */
export async function pendingRequests(db: Queryable, owner: string): Promise<AdminRequest[]> {
  const rows = await db.query<RequestRow>(
    `select ${COLUMNS} from admin_requests where owner = $1 and state = 'pending'
     order by created_at, id`,
    [owner],
  );
  return rows.map(rowToRequest);
}

/**
 * Write the result of a request already marked applied in a ledger save (a
 * hand answer's delivery outcome, a setup pass's summary). False when the
 * request is not `owner`'s applied one.
 */
export async function setRequestResult(
  db: Queryable,
  owner: string,
  id: string,
  result: unknown,
): Promise<boolean> {
  const rows = await db.query(
    `update admin_requests set result = $3 where id = $1 and owner = $2 and state = 'applied'
     returning 1`,
    [id, owner, JSON.stringify(result)],
  );
  return rows.length > 0;
}

/**
 * The owner's hand answers saved (applied) whose delivery outcome was never
 * written: the holder stopped between the save and the publish. Oldest first.
 */
export async function unsentHandAnswers(db: Queryable, owner: string): Promise<AdminRequest[]> {
  const rows = await db.query<RequestRow>(
    `select ${COLUMNS} from admin_requests
     where owner = $1 and kind = 'hand_answer' and state = 'applied' and result is null
     order by created_at, id`,
    [owner],
  );
  return rows.map(rowToRequest);
}

/** Of `owners`, the ones with a pending request or an unsent hand answer. */
export async function ownersWithRequests(
  db: Queryable,
  owners: readonly string[],
): Promise<string[]> {
  if (owners.length === 0) {
    return [];
  }
  const rows = await db.query<{ owner: string }>(
    `select distinct owner from admin_requests
     where owner = any($1::text[])
       and (state = 'pending' or (kind = 'hand_answer' and state = 'applied' and result is null))
     order by owner`,
    [owners],
  );
  return rows.map((row) => row.owner);
}
