/**
 * The `store_moves` rows as the rest of the server reads them: a store's
 * latest move (the one that may still be switching), its former owners, and
 * whether an owner key moved its store away. The move itself is `moves.ts`.
 */
import type { Queryable } from '../db/db';

/** A store's move as the holder side reads it. */
export interface StoreMove {
  id: number;
  fromOwner: string;
  toOwner: string;
  storePubkey: string;
  movedAt: number;
  /** `created_at` of the first profile naming the new owner that went out; undefined while switching. */
  switchedAt: number | undefined;
}

/** A store's former owner and when buyers were told of the next one (undefined: not yet). */
export interface FormerOwner {
  owner: string;
  switchedAt: number | undefined;
}

interface MoveRow extends Record<string, unknown> {
  id: number;
  from_owner: string;
  to_owner: string;
  store_pubkey: string;
  moved_at: number;
  switched_at: number | null;
}

const MOVE_COLUMNS = 'id, from_owner, to_owner, store_pubkey, moved_at, switched_at';

function toMove(row: MoveRow): StoreMove {
  return {
    id: row.id,
    fromOwner: row.from_owner,
    toOwner: row.to_owner,
    storePubkey: row.store_pubkey,
    movedAt: row.moved_at,
    switchedAt: row.switched_at ?? undefined,
  };
}

/** Every move of store S, oldest first. */
export async function storeMoves(db: Queryable, storePubkey: string): Promise<StoreMove[]> {
  const rows = await db.query<MoveRow>(
    `select ${MOVE_COLUMNS} from store_moves where store_pubkey = $1 order by id`,
    [storePubkey],
  );
  return rows.map(toMove);
}

/** Store S's latest move, if it ever moved. */
export async function latestMove(
  db: Queryable,
  storePubkey: string,
): Promise<StoreMove | undefined> {
  const [row] = await db.query<MoveRow>(
    `select ${MOVE_COLUMNS} from store_moves where store_pubkey = $1 order by id desc limit 1`,
    [storePubkey],
  );
  return row === undefined ? undefined : toMove(row);
}

/**
 * Whether store S is switching to its new owner: its latest move's first
 * profile naming the new owner has not gone out yet.
 */
export async function isSwitching(db: Queryable, storePubkey: string): Promise<boolean> {
  const move = await latestMove(db, storePubkey);
  return move !== undefined && move.switchedAt === undefined;
}

/** Store S's former owners, oldest first, each with its move's switch. */
export async function formerOwners(db: Queryable, storePubkey: string): Promise<FormerOwner[]> {
  return (await storeMoves(db, storePubkey)).map((move) => ({
    owner: move.fromOwner,
    switchedAt: move.switchedAt,
  }));
}

/** Whether `owner` moved its store away (it never owns one here again). */
export async function movedAway(db: Queryable, owner: string): Promise<boolean> {
  const rows = await db.query('select 1 from store_moves where from_owner = $1', [owner]);
  return rows.length > 0;
}

/** The current owner of the store `owner` moved away from (after every later move), if it moved. */
export async function currentOwnerAfterMove(
  db: Queryable,
  owner: string,
): Promise<string | undefined> {
  const [row] = await db.query<{ owner: string }>(
    `select s.owner from store_moves m join stores s on s.store_pubkey = m.store_pubkey
     where m.from_owner = $1`,
    [owner],
  );
  return row?.owner;
}

/** The advisory lock every write that gives an owner key a store takes (moves, creation, import). */
export async function lockOwnerKey(tx: Queryable, owner: string): Promise<void> {
  await tx.query(
    `select pg_advisory_xact_lock(hashtextextended('paycore:store-owner:' || $1, 0))`,
    [owner],
  );
}

/** Refused: the owner key moved its store away and never opens one again. */
export class StoreMovedError extends Error {
  constructor(readonly owner: string) {
    super('this owner key moved its store to another key: it cannot open a store again');
    this.name = 'StoreMovedError';
  }
}
