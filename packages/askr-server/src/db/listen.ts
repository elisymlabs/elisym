import { Backoff } from '../relay/backoff';

/** The part of a dedicated database connection a listener uses. */
export interface ListenConnection {
  query(sql: string): Promise<void>;
  /** Called with the channel of every notification. */
  onNotification(listener: (channel: string) => void): void;
  /** Called when the connection errors or ends (possibly more than once). */
  onLost(listener: (error: Error | undefined) => void): void;
  /** Give the connection back; `broken` destroys it. */
  release(broken: boolean): void;
}

export interface ListenOptions {
  connect: () => Promise<ListenConnection>;
  channel: string;
  /** `listen <channel>` and `unlisten <channel>`, the channel already escaped. */
  listenSql: string;
  unlistenSql: string;
  onNotify: () => void;
  log: (message: string) => void;
  backoff?: Pick<Backoff, 'next' | 'reset'>;
}

/**
 * LISTEN on a dedicated connection that comes back: when it errors or ends
 * (a Postgres restart), it is dropped, and a new one is connected and LISTENs
 * again after a growing backoff; once it is back, `onNotify` runs once, since
 * a notify may have been missed meanwhile (the server's one-minute poll
 * covers the time it is down, 7.3). The first connect must succeed; resolves
 * to the function that stops listening.
 */
export async function listenWithReconnect(options: ListenOptions): Promise<() => Promise<void>> {
  const backoff = options.backoff ?? new Backoff();
  let stopped = false;
  let current: { connection: ListenConnection; release: (broken: boolean) => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect(): void {
    timer = setTimeout(() => {
      timer = undefined;
      attach().then(
        (attached) => {
          if (attached) {
            backoff.reset();
            options.onNotify();
          }
        },
        (error: unknown) => {
          if (stopped) {
            return;
          }
          options.log(
            `listen reconnect failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
          scheduleReconnect();
        },
      );
    }, backoff.next());
  }

  /** Connect and LISTEN; false when stopped meanwhile. */
  async function attach(): Promise<boolean> {
    const connection = await options.connect();
    let released = false;
    const release = (broken: boolean) => {
      if (!released) {
        released = true;
        connection.release(broken);
      }
    };
    connection.onLost((error) => {
      const wasCurrent = current?.connection === connection;
      if (wasCurrent) {
        current = undefined;
      }
      release(true);
      if (wasCurrent && !stopped) {
        options.log(`listen connection lost: ${error?.message ?? 'ended'}`);
        scheduleReconnect();
      }
    });
    connection.onNotification((channel) => {
      if (channel === options.channel && current?.connection === connection) {
        options.onNotify();
      }
    });
    try {
      await connection.query(options.listenSql);
    } catch (error) {
      release(true);
      throw error;
    }
    if (stopped || released) {
      release(true);
      if (!stopped) {
        throw new Error('the connection was lost while listening');
      }
      return false;
    }
    current = { connection, release };
    return true;
  }

  await attach();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    const attached = current;
    current = undefined;
    if (attached) {
      await attached.connection.query(options.unlistenSql).catch(() => undefined);
      attached.release(false);
    }
  };
}
