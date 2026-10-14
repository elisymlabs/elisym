/**
 * A Bun preload for the CLI tests (`bun --preload <this> src/cli.ts ...`): it
 * keeps the command off the network. Every relay the command opens is one
 * in-memory relay, and every HTTP request fails except to `fee-rpc.harness`,
 * a Solana JSON-RPC that answers only `getGenesisHash` and, when asked to,
 * `getAccountInfo` with an elisym config account. What the command did
 * is written to `$HARNESS_DIR`, one JSON line each:
 *
 * - `published.jsonl`: every event a relay took;
 * - `reqs.jsonl`: every subscription's filters;
 * - `fetches.jsonl`: every HTTP request's host and JSON-RPC methods.
 *
 * Set by the test: `HARNESS_DIR` (required), `seed.json` in it (events the
 * relay holds at start), `HARNESS_REJECT_KINDS` (event kinds every relay
 * refuses, comma-separated), `HARNESS_GENESIS` (the genesis hash the config
 * RPC answers; unset, it does not answer), `HARNESS_CONFIG` (JSON
 * `{ treasury, feeBps }`: the config account every `getAccountInfo` answers;
 * unset, it answers an error), `HARNESS_CONFIG_FROM` (the first
 * `getAccountInfo` call, counted from 1, that gets the account; the earlier
 * ones get an error; default 1).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { address } from '@solana/kit';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { getConfigEncoder } from '../../../config-client/src/generated/accounts/config';

const FEE_RPC_HOST = 'fee-rpc.harness';

const HARNESS_DIR = process.env.HARNESS_DIR;
if (HARNESS_DIR === undefined) {
  throw new Error('relay-preload: HARNESS_DIR is not set');
}
const harnessDir: string = HARNESS_DIR;

function record(file: string, entry: unknown): void {
  appendFileSync(join(harnessDir, file), `${JSON.stringify(entry)}\n`);
}

const REJECTED_KINDS = new Set(
  (process.env.HARNESS_REJECT_KINDS ?? '')
    .split(',')
    .filter((kind) => kind !== '')
    .map(Number),
);

const SEED_FILE = join(harnessDir, 'seed.json');
const stored: NostrEvent[] = existsSync(SEED_FILE)
  ? (JSON.parse(readFileSync(SEED_FILE, 'utf8')) as NostrEvent[])
  : [];

interface Subscription {
  socket: FakeRelaySocket;
  id: string;
  filters: Filter[];
}

const live = new Map<string, Subscription>();

/** The WebSocket nostr-tools opens: every URL reaches the one in-memory relay. */
class FakeRelaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeRelaySocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private readonly subscriptionIds = new Set<string>();

  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = FakeRelaySocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const message = JSON.parse(data) as unknown[];
    setTimeout(() => this.handle(message), 0);
  }

  close(): void {
    if (this.readyState === FakeRelaySocket.CLOSED) {
      return;
    }
    this.readyState = FakeRelaySocket.CLOSED;
    for (const id of this.subscriptionIds) {
      live.delete(id);
    }
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }

  deliver(message: unknown[]): void {
    if (this.readyState === FakeRelaySocket.OPEN) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  private handle(message: unknown[]): void {
    const [type] = message;
    if (type === 'EVENT') {
      const event = message[1] as NostrEvent;
      if (REJECTED_KINDS.has(event.kind)) {
        this.deliver(['OK', event.id, false, 'blocked: refused by the test relay']);
        return;
      }
      if (!stored.some((each) => each.id === event.id)) {
        stored.push(event);
        record('published.jsonl', { relay: this.url, event });
        for (const subscription of live.values()) {
          if (subscription.filters.some((filter) => matchFilter(filter, event))) {
            subscription.socket.deliver(['EVENT', subscription.id, event]);
          }
        }
      }
      this.deliver(['OK', event.id, true, '']);
      return;
    }
    if (type === 'REQ') {
      const id = String(message[1]);
      const filters = message.slice(2) as Filter[];
      record('reqs.jsonl', { relay: this.url, filters });
      const sent = new Set<string>();
      for (const filter of filters) {
        const matching = stored.filter((event) => matchFilter(filter, event));
        const newest = [...matching]
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, filter.limit ?? matching.length);
        // In the order the relay took them: a test seeds them in the order it wants read.
        for (const event of matching) {
          if (newest.includes(event) && !sent.has(event.id)) {
            sent.add(event.id);
            this.deliver(['EVENT', id, event]);
          }
        }
      }
      this.deliver(['EOSE', id]);
      const key = `${this.url}#${id}#${Math.random()}`;
      this.subscriptionIds.add(key);
      live.set(key, { socket: this, id, filters });
      return;
    }
    if (type === 'CLOSE') {
      const id = String(message[1]);
      for (const key of this.subscriptionIds) {
        if (live.get(key)?.id === id) {
          live.delete(key);
          this.subscriptionIds.delete(key);
        }
      }
    }
  }
}

function urlOf(input: unknown): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL((input as { url: string }).url);
}

interface JsonRpcCall {
  id: unknown;
  method: string;
}

function rpcCalls(body: unknown): JsonRpcCall[] {
  if (typeof body !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(body) as JsonRpcCall | JsonRpcCall[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

const CONFIG = process.env.HARNESS_CONFIG;
const CONFIG_FROM = Number(process.env.HARNESS_CONFIG_FROM ?? '1');
let accountInfoCalls = 0;

/** The config account `HARNESS_CONFIG` describes, as `getAccountInfo` returns it (base64). */
function configAccount(): unknown {
  if (CONFIG === undefined) {
    return undefined;
  }
  const { treasury, feeBps } = JSON.parse(CONFIG) as { treasury: string; feeBps: number };
  const bytes = getConfigEncoder().encode({
    version: 1,
    bump: 255,
    admin: address(treasury),
    pendingAdmin: null,
    treasury: address(treasury),
    feeBps,
    paused: false,
    lastUpdated: 0,
    evmTreasury: new Uint8Array(20),
    reserved: new Uint8Array(108),
  });
  return {
    context: { slot: 1 },
    value: {
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: '11111111111111111111111111111111',
      rentEpoch: 0,
      space: bytes.length,
    },
  };
}

function answer(call: JsonRpcCall, genesis: string): unknown {
  if (call.method === 'getGenesisHash') {
    return { jsonrpc: '2.0', id: call.id, result: genesis };
  }
  if (call.method === 'getAccountInfo') {
    accountInfoCalls += 1;
    const account = accountInfoCalls >= CONFIG_FROM ? configAccount() : undefined;
    if (account !== undefined) {
      return { jsonrpc: '2.0', id: call.id, result: account };
    }
  }
  return {
    jsonrpc: '2.0',
    id: call.id,
    error: { code: -32601, message: 'not served by the test RPC' },
  };
}

async function harnessFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const url = urlOf(input);
  const calls = rpcCalls(init?.body);
  record('fetches.jsonl', { host: url.host, methods: calls.map((call) => call.method) });
  const genesis = process.env.HARNESS_GENESIS;
  if (url.host !== FEE_RPC_HOST || genesis === undefined) {
    throw new TypeError(`no network in the CLI tests (${url.host})`);
  }
  const answers = calls.map((call) => answer(call, genesis));
  const parsed = JSON.parse(String(init?.body)) as unknown;
  return new Response(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: FakeRelaySocket,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'fetch', {
  value: harnessFetch,
  configurable: true,
  writable: true,
});
