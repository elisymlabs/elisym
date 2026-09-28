import { describe, expect, it } from 'vitest';
import {
  HELLO_TIMEOUT_MS,
  type HandshakeRefusal,
  type HandshakeWindow,
  acceptHandshake,
} from '../src/app/handshake';

const PAGE = 'https://merchant.example';

/** The iframe's window with a parent page, timers run by hand. */
function frameWindow(framed = true) {
  const posted: { message: unknown; origin: string }[] = [];
  const parent = {
    postMessage: (message: unknown, origin: string) => posted.push({ message, origin }),
  };
  let listener: ((event: MessageEvent) => void) | undefined;
  let timer: (() => void) | undefined;
  const self: HandshakeWindow = {
    parent: undefined,
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    removeEventListener: (_type, handler) => {
      if (listener === handler) {
        listener = undefined;
      }
    },
    setTimeout: (handler) => {
      timer = handler;
      return 1;
    },
    clearTimeout: () => {
      timer = undefined;
    },
  };
  self.parent = framed ? parent : self;
  return {
    self,
    parent,
    posted,
    send: (data: unknown, origin: string, source: unknown = parent) =>
      listener?.({ data, origin, source } as unknown as MessageEvent),
    fireTimeout: () => timer?.(),
    listening: () => listener !== undefined,
  };
}

function run(framed = true) {
  const window = frameWindow(framed);
  const accepted: string[] = [];
  const refused: HandshakeRefusal[] = [];
  const handshake = acceptHandshake(
    window.self,
    (origin) => accepted.push(origin),
    (reason) => refused.push(reason),
  );
  return { ...window, accepted, refused, handshake };
}

describe('the handshake', () => {
  it('takes the first hello from the framing page and answers it there only', () => {
    const frame = run();
    frame.send({ type: 'hello' }, PAGE);
    expect(frame.accepted).toEqual([PAGE]);
    expect(frame.posted).toEqual([{ message: { type: 'ack' }, origin: PAGE }]);
    frame.handshake.status('paid');
    expect(frame.posted.at(-1)).toEqual({
      message: { type: 'status', state: 'paid' },
      origin: PAGE,
    });
  });

  it('never takes a hello from another window, an opaque origin or a non-hello', () => {
    const frame = run();
    // MetaMask's content script posts into the frame with the frame's own origin.
    frame.send({ type: 'hello' }, PAGE, { someOther: 'window' });
    frame.send({ type: 'hello' }, 'null');
    frame.send({ type: 'hello' }, 'chrome-extension://abc');
    frame.send({ type: 'ping' }, PAGE);
    frame.send('hello', PAGE);
    expect(frame.accepted).toEqual([]);
    expect(frame.posted).toEqual([]);
    frame.fireTimeout();
    expect(frame.refused).toEqual(['no_hello']);
    // Too late: a hello after the refusal changes nothing.
    frame.send({ type: 'hello' }, PAGE);
    expect(frame.accepted).toEqual([]);
  });

  it('counts only the first hello; a repeat from the same page is acknowledged again', () => {
    const frame = run();
    frame.send({ type: 'hello' }, PAGE);
    frame.send({ type: 'hello' }, 'https://other.example');
    frame.send({ type: 'hello' }, PAGE);
    expect(frame.accepted).toEqual([PAGE]);
    expect(frame.posted.map((entry) => entry.origin)).toEqual([PAGE, PAGE]);
    // An accepted hello cancels the refusal.
    frame.fireTimeout();
    expect(frame.refused).toEqual([]);
  });

  it('refuses at once when not framed, and after the timeout without a hello', () => {
    const direct = run(false);
    expect(direct.refused).toEqual(['not_framed']);
    expect(direct.listening()).toBe(false);
    const silent = run();
    expect(silent.listening()).toBe(true);
    silent.fireTimeout();
    expect(silent.refused).toEqual(['no_hello']);
    expect(silent.listening()).toBe(false);
    expect(HELLO_TIMEOUT_MS).toBe(5000);
  });

  it('posts nothing before a hello is taken', () => {
    const frame = run();
    frame.handshake.status('ready');
    frame.handshake.post({ type: 'resize', height: 300 });
    expect(frame.posted).toEqual([]);
  });
});
