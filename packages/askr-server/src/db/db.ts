/** One SQL statement's runner: the part of a client a transaction shares. */
export interface Queryable {
  query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Run a script of several statements without parameters (migrations). */
  script(sql: string): Promise<void>;
}

/**
 * The server's database (9): a small query interface implemented by the
 * production `pg` pool and by PGlite in tests. Both return `int8` as a number
 * and `numeric` as a decimal string, so money never passes through a float.
 */
export interface Db extends Queryable {
  /** Run `work` in one transaction; a throw rolls it back. */
  transaction<Result>(work: (tx: Queryable) => Promise<Result>): Promise<Result>;
  /** Listen on a channel; resolves to the function that stops listening. */
  listen(channel: string, onNotify: () => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** The channel the operator CLI notifies after a store state change (7.3). */
export const STORES_CHANNEL = 'askr_stores';
