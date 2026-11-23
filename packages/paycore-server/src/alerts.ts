/**
 * Operator alerts: a structured log line, and one open row per (store, kind)
 * in `alerts` that a repeat refreshes (message, last seen, count) until the
 * operator or the code that raised it clears it.
 */
import type { Queryable } from './db/db';

/** The kinds the store supervisor raises. Other modules add their own. */
export const ALERT_KINDS = {
  /** A start refused by a check (lost history, prices, relays, RPCs, a webhook without its secret). */
  startRefused: 'start_refused',
  /** `MAX_FAILED_STARTS` starts in a row failed. */
  startFailed: 'start_failed',
  /** A running node stopped itself (a save refused, the fee config of another cluster). */
  nodeStopped: 'node_stopped',
  /** The relays offer buyers terms the ledger does not honour: the store runs `degraded`. */
  offerMismatch: 'offer_mismatch',
} as const;

export interface AlertOptions {
  /** Seconds. */
  now?: number;
  /** Where the structured line goes. Default: stderr. */
  log?: (line: string) => void;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultLog(line: string): void {
  console.error(line);
}

/**
 * Raise an alert for `owner` (or the whole server, `undefined`): log it and
 * open its row, or refresh the open row of the same owner and kind.
 */
export async function raiseAlert(
  db: Queryable,
  owner: string | undefined,
  kind: string,
  message: string,
  options: AlertOptions = {},
): Promise<void> {
  const at = options.now ?? nowSecs();
  (options.log ?? defaultLog)(JSON.stringify({ alert: kind, owner: owner ?? null, message }));
  await db.query(
    `insert into alerts (owner, kind, message, created_at, last_seen_at)
     values ($1, $2, $3, $4, $4)
     on conflict ((coalesce(owner, '')), kind) where cleared_at is null
     do update set message = excluded.message, last_seen_at = excluded.last_seen_at,
       count = alerts.count + 1`,
    [owner ?? null, kind, message, at],
  );
}

/** Clear the open alert of `owner` and `kind`; true when one was open. */
export async function clearAlert(
  db: Queryable,
  owner: string | undefined,
  kind: string,
  options: Pick<AlertOptions, 'now'> = {},
): Promise<boolean> {
  const cleared = await db.query(
    `update alerts set cleared_at = $3
     where coalesce(owner, '') = coalesce($1::text, '') and kind = $2 and cleared_at is null
     returning id`,
    [owner ?? null, kind, options.now ?? nowSecs()],
  );
  return cleared.length > 0;
}
