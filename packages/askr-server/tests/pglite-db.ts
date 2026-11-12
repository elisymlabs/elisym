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

/** The test database: PGlite in process behind the server's `Db` interface (9). */
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

/** A fresh migrated database, cloned from one migrated per test file. */
export async function freshDb(): Promise<Db> {
  template ??= migratedTemplate();
  return pgliteDb(await (await template).clone());
}
