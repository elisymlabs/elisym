import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SyncRelayClient, buildCatalogAuth } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type {
  FetchGuardDeps,
  ResolvedAddress,
  TransportRequest,
  TransportResponse,
} from '../../src/connectors/fetch-guard';

export const NOW = 1_800_000_000;
export const PUBLIC_IP: ResolvedAddress = { address: '93.184.216.34', family: 4 };

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name));
}

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Split the body into chunks of this many bytes. */
  chunkBytes?: number;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

/** A fake internet: URL to response, host to addresses; records every request. */
export class FakeWeb {
  readonly routes = new Map<string, Route | (() => Route)>();
  readonly hosts = new Map<string, ResolvedAddress[]>();
  readonly requests: TransportRequest[] = [];
  discarded = 0;

  route(url: string, route: Route | (() => Route)): this {
    this.routes.set(url, route);
    return this;
  }

  json(url: string, value: unknown): this {
    return this.route(url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  }

  get urls(): string[] {
    return this.requests.map((request) => request.url.toString());
  }

  deps(): FetchGuardDeps {
    return {
      resolve: async (hostname) => this.hosts.get(hostname) ?? [PUBLIC_IP],
      transport: async (request): Promise<TransportResponse> => {
        this.requests.push(request);
        const entry = this.routes.get(request.url.toString());
        const route: Route =
          typeof entry === 'function' ? entry() : (entry ?? { status: 404, body: 'not found' });
        const bytes = new TextEncoder().encode(route.body ?? '');
        return {
          status: route.status ?? 200,
          headers: route.headers ?? {},
          body: chunked(bytes, route.chunkBytes ?? 64 * 1024),
          discard: () => {
            this.discarded += 1;
          },
        };
      },
    };
  }
}

function matches(event: NostrEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  return !filter.authors || filter.authors.includes(event.pubkey);
}

export class MemoryRelay implements SyncRelayClient {
  readonly events: NostrEvent[] = [];
  readonly published: NostrEvent[] = [];

  async query(_relays: readonly string[], filter: Filter): Promise<NostrEvent[]> {
    return this.events.filter((event) => matches(event, filter));
  }

  async publish(_relays: readonly string[], event: NostrEvent): Promise<void> {
    this.published.push(event);
    this.events.push(event);
  }
}

export interface StoreKeys {
  owner: string;
  ownerNpub: string;
  serverKey: Uint8Array;
  server: string;
  relay: MemoryRelay;
}

/** An owner O, a server K it authorizes as a catalog key, and a relay holding that 30497. */
export function storeKeys(): StoreKeys {
  const ownerSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  const serverKey = generateSecretKey();
  const server = getPublicKey(serverKey);
  const relay = new MemoryRelay();
  relay.events.push(
    finalizeEvent(
      buildCatalogAuth({ key: server, mode: 'hosted', createdAt: NOW - 100 }),
      ownerSecret,
    ),
  );
  return { owner, ownerNpub: npubEncode(owner), serverKey, server, relay };
}

export const noSleep = async (): Promise<void> => undefined;
