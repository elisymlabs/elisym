import { describe, expect, it } from 'vitest';
import { type ListenConnection, listenWithReconnect } from '../src/db/listen';

class FakeConnection implements ListenConnection {
  readonly queries: string[] = [];
  released: boolean | undefined;
  failQuery = false;
  private notification: ((channel: string) => void) | undefined;
  private lost: ((error: Error | undefined) => void) | undefined;

  async query(sql: string): Promise<void> {
    this.queries.push(sql);
    if (this.failQuery) {
      throw new Error('connection refused');
    }
  }
  onNotification(listener: (channel: string) => void): void {
    this.notification = listener;
  }
  onLost(listener: (error: Error | undefined) => void): void {
    this.lost = listener;
  }
  release(broken: boolean): void {
    if (this.released !== undefined) {
      throw new Error('released twice');
    }
    this.released = broken;
  }
  notify(channel: string): void {
    this.notification?.(channel);
  }
  lose(error?: Error): void {
    this.lost?.(error);
  }
}

async function waitUntil(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup(failConnects = 0) {
  const connections: FakeConnection[] = [];
  const notified: string[] = [];
  const logs: string[] = [];
  let refusals = failConnects;
  const options = {
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      if (connections.length > 1 && refusals > 0) {
        refusals -= 1;
        connection.failQuery = true;
      }
      return connection;
    },
    channel: 'askr_stores',
    listenSql: 'listen "askr_stores"',
    unlistenSql: 'unlisten "askr_stores"',
    onNotify: () => notified.push('notify'),
    log: (message: string) => logs.push(message),
    backoff: { next: () => 10, reset: () => undefined },
  };
  return { connections, notified, logs, options };
}

describe('LISTEN that comes back (7.3)', () => {
  it('reconnects and listens again after the connection is lost, and runs onNotify once back', async () => {
    const { connections, notified, logs, options } = setup();
    const stop = await listenWithReconnect(options);
    const [first] = connections;
    first?.notify('askr_stores');
    first?.notify('other');
    expect(notified).toEqual(['notify']);
    first?.lose(new Error('terminating connection due to administrator command'));
    expect(first?.released).toBe(true);
    expect(logs).toEqual([
      'listen connection lost: terminating connection due to administrator command',
    ]);
    // A loss reported twice (error, then end) reconnects once.
    first?.lose();
    await waitUntil(() => connections.length === 2 && notified.length === 2);
    const second = connections[1];
    expect(second?.queries).toEqual(['listen "askr_stores"']);
    // The dropped connection is deaf; the new one hears.
    first?.notify('askr_stores');
    second?.notify('askr_stores');
    expect(notified).toEqual(['notify', 'notify', 'notify']);
    await stop();
    expect(second?.queries).toEqual(['listen "askr_stores"', 'unlisten "askr_stores"']);
    expect(second?.released).toBe(false);
    second?.lose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toHaveLength(2);
  });

  it('keeps retrying a reconnect that fails', async () => {
    const { connections, notified, logs, options } = setup(2);
    const stop = await listenWithReconnect(options);
    connections[0]?.lose();
    await waitUntil(() => connections.length === 4 && notified.length === 1);
    expect(logs.filter((message) => message.startsWith('listen reconnect failed'))).toHaveLength(2);
    expect(connections.slice(1, 3).map((connection) => connection.released)).toEqual([true, true]);
    await stop();
  });

  it('a stop while reconnecting leaves nothing listening', async () => {
    const { connections, options } = setup();
    const stop = await listenWithReconnect(options);
    connections[0]?.lose();
    await stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toHaveLength(1);
  });
});
