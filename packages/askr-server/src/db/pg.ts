import { type Notification, Pool, type PoolClient, escapeIdentifier, types } from 'pg';
import type { Db, Queryable } from './db';

const INT8_OID = 20;
const NUMERIC_OID = 1700;

/** `int8` as a number (unix times and counts stay far below 2^53) and `numeric` as its exact text. */
const TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID) {
      return (value: string) => Number(value);
    }
    if (oid === NUMERIC_OID) {
      return (value: string) => value;
    }
    return types.getTypeParser(oid, format);
  },
};

function runner(client: Pool | PoolClient): Queryable {
  return {
    async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query<Row>({ text: sql, values: params, types: TYPES });
      return result.rows;
    },
    async script(sql: string) {
      // No parameters: the simple protocol, which runs several statements.
      await client.query(sql);
    },
  };
}

/** The production database: a `pg` pool on `DATABASE_URL`. */
export function createPgDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 10 });
  const base = runner(pool);
  return {
    query: base.query,
    script: base.script,
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await work(runner(client));
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async listen(channel, onNotify) {
      const client = await pool.connect();
      const handler = (message: Notification) => {
        if (message.channel === channel) {
          onNotify();
        }
      };
      client.on('notification', handler);
      await client.query(`listen ${escapeIdentifier(channel)}`);
      return async () => {
        client.off('notification', handler);
        await client.query(`unlisten ${escapeIdentifier(channel)}`).catch(() => undefined);
        client.release();
      };
    },
    async close() {
      await pool.end();
    },
  };
}
