import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RelayConnection,
  type RelaySubscriptionHandlers,
  openHistoryRead,
} from '../src/relay';

interface StubConnection {
  connection: RelayConnection;
  handlers: () => RelaySubscriptionHandlers;
  closes: () => number;
}

/** A connection whose single subscription the test drives by hand. */
function stubConnection(): StubConnection {
  let captured: RelaySubscriptionHandlers | undefined;
  let closes = 0;
  const connection: RelayConnection = {
    url: 'wss://relay.test',
    onclose: undefined,
    subscribe(_filters, handlers) {
      captured = handlers;
      return {
        close: () => {
          closes += 1;
        },
      };
    },
    publish: () => Promise.resolve(),
    close: () => undefined,
  };
  return {
    connection,
    handlers: () => {
      if (!captured) {
        throw new Error('no subscription');
      }
      return captured;
    },
    closes: () => closes,
  };
}

function openRead(stub: StubConnection) {
  const calls = { eose: 0, fail: 0, closedAfterEose: 0, events: 0 };
  const read = openHistoryRead(stub.connection, [{ kinds: [1059] }], {
    onevent: () => {
      calls.events += 1;
    },
    onEose: () => {
      calls.eose += 1;
    },
    onFail: () => {
      calls.fail += 1;
    },
    onClosedAfterEose: () => {
      calls.closedAfterEose += 1;
    },
  });
  return { calls, read };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openHistoryRead', () => {
  it('a real EOSE before close and before the timer counts once', () => {
    const stub = stubConnection();
    const { calls } = openRead(stub);
    stub.handlers().oneose();
    stub.handlers().oneose();
    vi.advanceTimersByTime(20_000);
    expect(calls).toEqual({ eose: 1, fail: 0, closedAfterEose: 0, events: 0 });
    stub.handlers().onclose('relay closed');
    expect(calls).toEqual({ eose: 1, fail: 0, closedAfterEose: 1, events: 0 });
  });

  it('an oneose after the subscription closed is not a real EOSE', () => {
    const stub = stubConnection();
    const { calls } = openRead(stub);
    stub.handlers().onclose('connection closed');
    stub.handlers().oneose();
    expect(calls).toEqual({ eose: 0, fail: 1, closedAfterEose: 0, events: 0 });
  });

  it('an oneose after our own no-EOSE timer is not a real EOSE; the timer CLOSEs the REQ', () => {
    const stub = stubConnection();
    const { calls } = openRead(stub);
    vi.advanceTimersByTime(15_000);
    expect(calls).toEqual({ eose: 0, fail: 1, closedAfterEose: 0, events: 0 });
    expect(stub.closes()).toBe(1);
    // nostr-tools' own eoseTimeout fires later and calls oneose.
    stub.handlers().oneose();
    stub.handlers().onclose('closed by caller');
    expect(calls).toEqual({ eose: 0, fail: 1, closedAfterEose: 0, events: 0 });
  });

  it('an oneose just before the timer counts', () => {
    const stub = stubConnection();
    const { calls } = openRead(stub);
    vi.advanceTimersByTime(14_999);
    stub.handlers().oneose();
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual({ eose: 1, fail: 0, closedAfterEose: 0, events: 0 });
  });

  it('after our own close, neither a late oneose nor an event nor the timer reports anything', () => {
    const stub = stubConnection();
    const { calls, read } = openRead(stub);
    read.close();
    expect(stub.closes()).toBe(1);
    stub.handlers().oneose();
    stub.handlers().onevent({
      id: '0'.repeat(64),
      pubkey: '0'.repeat(64),
      created_at: 1,
      kind: 1059,
      tags: [],
      content: '',
      sig: '0'.repeat(128),
    });
    vi.advanceTimersByTime(20_000);
    stub.handlers().onclose('closed by caller');
    expect(calls).toEqual({ eose: 0, fail: 0, closedAfterEose: 0, events: 0 });
  });

  it('events after a failed read are dropped', () => {
    const stub = stubConnection();
    const { calls } = openRead(stub);
    vi.advanceTimersByTime(15_000);
    stub.handlers().onevent({
      id: '0'.repeat(64),
      pubkey: '0'.repeat(64),
      created_at: 1,
      kind: 1059,
      tags: [],
      content: '',
      sig: '0'.repeat(128),
    });
    expect(calls).toEqual({ eose: 0, fail: 1, closedAfterEose: 0, events: 0 });
  });
});
