import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable } from '../src/db/db';
import { migrate } from '../src/db/migrations';

const INT8_OID = 20;
const NUMERIC_OID = 1700;
/** The same conversions as the production pool (src/db/pg.ts). */
const PARSERS = {
  [INT8_OID]: (value: string) => Number(value),
  [NUMERIC_OID]: (value: string) => value,
};

function runner(client: PGliteInterface | Transaction): Queryable {
  return {
    async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query<Row>(sql, params, { parsers: PARSERS });
      return result.rows;
    },
    async script(sql: string) {
      await client.exec(sql);
    },
  };
}

/** The test database: PGlite in process behind the server's `Db` interface. */
export function pgliteDb(client: PGliteInterface): Db {
  const base = runner(client);
  return {
    query: base.query,
    script: base.script,
    transaction: (work) => client.transaction((tx) => work(runner(tx))),
    async listen(channel, onNotify) {
      const unlisten = await client.listen(channel, () => onNotify());
      return async () => {
        await unlisten();
      };
    },
    close: () => client.close(),
  };
}

let template: Promise<PGliteInterface> | undefined;

async function migratedTemplate(): Promise<PGliteInterface> {
  const client = await PGlite.create();
  await migrate(pgliteDb(client));
  return client;
}

/** The clones the running test opened; tests/setup.ts closes them after it. */
const OPEN_CLONES: PGliteInterface[] = [];

/** A fresh migrated database, cloned from one migrated per test file. */
export async function freshDb(): Promise<Db> {
  template ??= migratedTemplate();
  const clone = await (await template).clone();
  OPEN_CLONES.push(clone);
  return pgliteDb(clone);
}

/**
 * Close every clone the test opened. Each is a whole Postgres in WebAssembly
 * memory (several hundred MB); left open, one test file grew past 7 GB and the
 * suite ran a CI runner out of memory.
 */
export async function closeOpenClones(): Promise<void> {
  const clones = OPEN_CLONES.splice(0);
  await Promise.all(clones.map((clone) => (clone.closed ? undefined : clone.close())));
}
