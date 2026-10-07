/**
 * Doubles for the modal-reset tests: a store that counts writes and can hold
 * any call, an RPC that can hold one method, and a gate to release later.
 */
import type { OrderRecord, OrderStore } from '@elisym/commerce/buyer';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import type { CheckoutSession } from '../src/app/session';

/** A promise the test opens when it chooses. */
export interface Gate {
  promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type StoreMethod =
  | 'get'
  | 'forProduct'
  | 'add'
  | 'update'
  | 'setMarker'
  | 'updateMarker'
  | 'clearMarker';

const WRITES: readonly StoreMethod[] = [
  'add',
  'update',
  'setMarker',
  'updateMarker',
  'clearMarker',
];

interface Hold {
  method: StoreMethod;
  when: (args: unknown[]) => boolean;
  gate: Gate;
  reached: Gate;
  used: boolean;
  /** Reject instead of answering, once opened. */
  reject: boolean;
  /** Answer this instead of the store's own answer (a copy read just before a write). */
  answer?: unknown;
}

/** One write the store was asked for, and whether it succeeded. */
export interface WriteCall {
  method: StoreMethod;
  orderId: string;
  ok?: boolean;
}

/**
 * The real store, seen through a spy: every write is recorded (asked, then
 * answered), and a test may hold the next matching call until it opens it.
 */
export function spyStore(real: OrderStore) {
  const writes: WriteCall[] = [];
  const holds: Hold[] = [];
  /** Writes refused (a lost compare-and-swap) while this says so. */
  let refuse: ((method: StoreMethod, args: unknown[]) => boolean) | undefined;
  const store = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const method = property as StoreMethod;
      const known = ['get', 'forProduct', ...WRITES].includes(method);
      if (!known) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        const call: WriteCall | undefined = WRITES.includes(method)
          ? { method, orderId: typeof args[0] === 'string' ? args[0] : '' }
          : undefined;
        if (call !== undefined) {
          writes.push(call);
        }
        const hold = holds.find((each) => !each.used && each.method === method && each.when(args));
        if (hold !== undefined) {
          hold.used = true;
          hold.reached.open();
          await hold.gate.promise;
          if (hold.reject) {
            throw new Error('held call failed');
          }
        }
        let result: unknown;
        if (call !== undefined && refuse?.(method, args) === true) {
          result = { ok: false, reason: 'conflict' };
        } else if (hold?.answer !== undefined) {
          result = hold.answer;
        } else {
          result = await value.apply(target, args);
        }
        if (call !== undefined && typeof result === 'object' && result !== null && 'ok' in result) {
          call.ok = result.ok === true;
        }
        return result;
      };
    },
  });
  return {
    store,
    writes,
    /** Hold the `nth` call (from now) of `method` matching `when`. */
    holdNth(method: StoreMethod, nth: number, when: (args: unknown[]) => boolean = () => true) {
      let seen = 0;
      const held: Hold = {
        method,
        when: (args) => {
          if (!when(args)) {
            return false;
          }
          seen += 1;
          return seen === nth;
        },
        gate: gate(),
        reached: gate(),
        used: false,
        reject: false,
      };
      holds.push(held);
      return { reached: held.reached.promise, release: held.gate.open };
    },
    /** Hold the next call of `method` matching `when`; `reached` opens when it is made. */
    hold(method: StoreMethod, when: (args: unknown[]) => boolean = () => true, reject = false) {
      const held: Hold = { method, when, gate: gate(), reached: gate(), used: false, reject };
      holds.push(held);
      return { reached: held.reached.promise, release: held.gate.open };
    },
    /** Hold the `nth` call of `get` for `orderId`, then answer it with `stale`. */
    holdStale(nth: number, orderId: string, stale: OrderRecord) {
      let seen = 0;
      const held: Hold = {
        method: 'get',
        when: (args) => {
          if (args[0] !== orderId) {
            return false;
          }
          seen += 1;
          return seen === nth;
        },
        gate: gate(),
        reached: gate(),
        used: false,
        reject: false,
        answer: stale,
      };
      holds.push(held);
      return { reached: held.reached.promise, release: held.gate.open };
    },
    /** Refuse every write `when` matches (until set again to `undefined`). */
    refuseWrites(when: ((method: StoreMethod, args: unknown[]) => boolean) | undefined) {
      refuse = when;
    },
    succeeded(method: StoreMethod): WriteCall[] {
      return writes.filter((write) => write.method === method && write.ok === true);
    },
  };
}

/** The RPC, with the next call of `method` held until the test opens it. */
export function holdRpc(rpc: Rpc<SolanaRpcApi>, method: keyof SolanaRpcApi, nth = 1) {
  const held = gate();
  const reached = gate();
  let used = false;
  let seen = 0;
  const wrapped = new Proxy(rpc, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== method || typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        const request: unknown = value.apply(target, args);
        return {
          send: async (...sendArgs: unknown[]) => {
            seen += 1;
            if (!used && seen === nth) {
              used = true;
              reached.open();
              await held.promise;
            }
            if (typeof request !== 'object' || request === null || !('send' in request)) {
              throw new Error('not a request');
            }
            const send: unknown = request.send;
            if (typeof send !== 'function') {
              throw new Error('not a request');
            }
            return send.apply(request, sendArgs);
          },
        };
      };
    },
  });
  return { rpc: wrapped, reached: reached.promise, release: held.open };
}

/** The session's private state a test reads (never writes): the record on screen and the sets. */
export function internals(session: CheckoutSession) {
  return session as unknown as {
    record: OrderRecord | undefined;
    quiet: Set<string>;
    silent: string | undefined;
    followers: Map<string, { timer: unknown; republish: unknown; relays: readonly string[] }>;
    listening: { orderId: string } | undefined;
    background: Map<string, unknown>;
    pendingAnswers: Map<string, OrderRecord>;
    unanswered: { press: number } | undefined;
    busy: boolean;
    pressing: boolean;
    relays: string[];
  };
}
