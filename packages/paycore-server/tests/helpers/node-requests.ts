import { type RequestKind, insertRequest } from '../../src/admin/requests';
import type { Db } from '../../src/db/db';

/** Queue a request in its own transaction, as an admin route does; resolves to its id. */
export function submitRequest(
  db: Db,
  owner: string,
  kind: RequestKind,
  payload: unknown,
  now: number,
): Promise<string> {
  return db.transaction((tx) => insertRequest(tx, owner, kind, payload, now));
}
