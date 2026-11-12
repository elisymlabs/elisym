import { type Notification, Pool, type PoolClient, escapeIdentifier, types } from 'pg';
import type { Db, Queryable } from './db';
import { type ListenConnection, listenWithReconnect } from './listen';

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

function listenConnection(client: PoolClient): ListenConnection {
  return {
    async query(sql) {
      await client.query(sql);
    },
    onNotification(listener) {
      client.on('notification', (message: Notification) => listener(message.channel));
    },
    onLost(listener) {
      client.on('error', (error: Error) => listener(error));
      client.on('end', () => listener(undefined));
    },
    release(broken) {
      client.release(broken);
    },
  };
}

/**
 * The production database: a `pg` pool on `DATABASE_URL`. A connection lost
 * while idle or checked out (a Postgres restart) is logged and dropped, never
 * an unhandled error that would end the process without releasing leases.
 */
export function createPgDb(
  connectionString: string,
  log: (message: string) => void = (message) => console.error(message),
): Db {
  const pool = new Pool({ connectionString, max: 10 });
  pool.on('error', (error) => log(`idle database connection lost: ${error.message}`));
  const base = runner(pool);
  return {
    query: base.query,
    script: base.script,
    async transaction(work) {
      const client = await pool.connect();
      let lost: Error | undefined;
      // A checked-out client has no listener of its own: one lost between queries must not crash.
      const onError = (error: Error) => {
        lost = error;
        log(`database connection lost in a transaction: ${error.message}`);
      };
      client.on('error', onError);
      try {
        await client.query('begin');
        const result = await work(runner(client));
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.off('error', onError);
        client.release(lost ?? false);
      }
    },
    listen(channel, onNotify) {
      return listenWithReconnect({
        connect: async () => listenConnection(await pool.connect()),
        channel,
        listenSql: `listen ${escapeIdentifier(channel)}`,
        unlistenSql: `unlisten ${escapeIdentifier(channel)}`,
        onNotify,
        log,
      });
    },
    async close() {
      await pool.end();
    },
  };
}
