/**
 * A fake Askr server and relay for the `askr` command tests: the admin routes
 * the CLI calls, NIP-98 checked, a relay of signed events, and hooks to make
 * any route answer otherwise (slow, refused, never).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as askr from '@elisym/askr';
import type { CatalogItemInput } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { expect, vi } from 'vitest';
import type { CommandOutcome } from '../src/commands/askr/errors';
import type { InitOptions } from '../src/commands/askr/init';
import { type AskrInvocation, runAskrCommand } from '../src/commands/askr/runner';
import type { AskrDeps, RelayHandle } from '../src/commands/askr/session';

export const BASE = 'http://localhost:9999';
export const RELAY = 'ws://localhost:7777';
export const ORIGIN = 'https://shop.example';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  /** The NIP-98 event id: a fresh one per request. */
  authId?: string;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

export interface FakeTier {
  name: string;
  maxProducts: number;
  branding: boolean;
}

export const FREE_TIER: FakeTier = { name: 'free', maxProducts: 100, branding: true };

interface StoredEvent {
  event: NostrEvent;
  published: boolean;
  stopped: boolean;
}

export interface FakeConnector {
  platform: string;
  url: string;
  currency?: string;
  importPolicies: boolean;
  enabled: boolean;
  lastStatus: unknown;
  lastRunAt: number | null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function decodeAuth(header: string | null): NostrEvent | undefined {
  if (header === null || !header.startsWith('Nostr ')) {
    return undefined;
  }
  const parsed: NostrEvent = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
  return verifyEvent(parsed) ? parsed : undefined;
}

export class FakeAskr {
  owner: string | undefined;
  status: 'pending' | 'active' | 'suspended' = 'pending';
  tier: FakeTier | null = null;
  movedFrom: string | null = null;
  readonly assistantSecret = generateSecretKey();
  readonly assistant = getPublicKey(this.assistantSecret);
  readonly catalogSecret = generateSecretKey();
  readonly catalogKey = getPublicKey(this.catalogSecret);
  stored: StoredEvent[] = [];
  relay: NostrEvent[] = [];
  connector: FakeConnector | null = null;
  catalogSync: { state: string; diff: unknown; error?: string } | null = null;
  /** Hold stored events unpublished on an active store. */
  holdPublication = false;
  /** How the next real catalog call's sync ends. */
  syncEnds: 'done' | 'running' | 'failed' = 'done';
  /** What a connector run stores once enabled; undefined: no run is seen. */
  runResult: unknown = undefined;
  previewResult: unknown = {
    status: 'ok',
    diff: { created: ['a'], updated: [], hidden: [], unchanged: [] },
    truncated: [],
    skipped: [],
  };
  freeAvailable = true;
  probeAnswers: Response[] = [];
  readonly calls: Call[] = [];
  private readonly overrides: Array<{ route: string; handler: Handler }> = [];
  private readonly authIds = new Set<string>();
  private products = new Map<string, CatalogItemInput>();

  /** Answer `route` (`METHOD /path`) with `handler` first; undefined falls through. */
  on(route: string, handler: Handler): void {
    this.overrides.push({ route, handler });
  }

  routeCalls(route: string): Call[] {
    return this.calls.filter((call) => `${call.method} ${call.path}` === route);
  }

  view(): Record<string, unknown> {
    const unpublished = this.stored.filter((entry) => !entry.published);
    return {
      owner: this.owner,
      status: this.status,
      tier: this.tier,
      assistant: this.assistant,
      nextAssistant: null,
      catalogKey: this.catalogKey,
      usage: { today: { spent: '0.10' }, month: { spent: '1.5' }, conversations: 2 },
      catalogSync: this.catalogSync,
      connector: this.connector,
      events: {
        pending: unpublished.length,
        failing: unpublished
          .filter((entry) => entry.stopped)
          .map((entry) => ({ id: entry.event.id, kind: entry.event.kind, stopped: true })),
      },
      movedFrom: this.movedFrom,
    };
  }

  /** The publisher: an active store's stored events reach the relay. */
  publish(): void {
    if (this.status !== 'active' || this.holdPublication) {
      return;
    }
    for (const entry of this.stored) {
      if (!entry.published && !entry.stopped) {
        entry.published = true;
        this.relay.push(entry.event);
      }
    }
  }

  signedByK(template: Parameters<typeof finalizeEvent>[0]): NostrEvent {
    return finalizeEvent(template, this.catalogSecret);
  }

  /** Products already listed by K, as a previous sync left them. */
  seedProducts(items: CatalogItemInput[]): void {
    for (const item of items) {
      this.products.set(item.d, item);
      this.relay.push(this.signedByK(askr.buildCatalogItemEvent(item)));
    }
  }

  private catalog(call: Call): Response {
    if (this.status !== 'active') {
      return json({ error: 'inactive' }, 409);
    }
    if (typeof call.body !== 'object' || call.body === null) {
      return json({ error: 'bad_request' }, 400);
    }
    const body: { mode?: string; items: CatalogItemInput[]; dryRun?: boolean } = JSON.parse(
      JSON.stringify(call.body),
    );
    const listed = [...this.products].filter(([, item]) => item.visibility !== 'hidden');
    if (this.tier !== null) {
      const total =
        body.mode === 'replace'
          ? body.items.length
          : new Set([...this.products.keys(), ...body.items.map((item) => item.d)]).size;
      if (total > this.tier.maxProducts) {
        return json({ error: 'too_many_products', max: this.tier.maxProducts }, 400);
      }
    }
    const diff = {
      created: [] as string[],
      updated: [] as string[],
      hidden: [] as string[],
      unchanged: [] as string[],
    };
    for (const item of body.items) {
      const before = this.products.get(item.d);
      if (before === undefined) {
        diff.created.push(item.d);
      } else if (JSON.stringify(before) !== JSON.stringify(item)) {
        diff.updated.push(item.d);
      } else {
        diff.unchanged.push(item.d);
      }
    }
    if (body.mode === 'replace') {
      const inFile = new Set(body.items.map((item) => item.d));
      diff.hidden = listed.map(([d]) => d).filter((d) => !inFile.has(d));
    }
    if (body.dryRun === true) {
      return json({ diff });
    }
    for (const item of body.items) {
      this.products.set(item.d, item);
      this.relay.push(this.signedByK(askr.buildCatalogItemEvent(item)));
    }
    for (const d of diff.hidden) {
      const item = this.products.get(d);
      if (item !== undefined) {
        const hidden = { ...item, visibility: 'hidden' as const };
        this.products.set(d, hidden);
        this.relay.push(this.signedByK(askr.buildCatalogItemEvent(hidden)));
      }
    }
    this.catalogSync =
      this.syncEnds === 'failed'
        ? { state: 'failed', diff, error: 'relay refused' }
        : { state: this.syncEnds, diff };
    return json({ diff, started: true }, 202);
  }

  private connectorRoute(call: Call): Response | undefined {
    const route = `${call.method} ${call.path}`;
    if (route === 'PUT /v1/admin/connector') {
      const body: { platform: string; url: string; currency?: string; importPolicies: boolean } =
        JSON.parse(JSON.stringify(call.body));
      const same =
        this.connector !== null &&
        this.connector.platform === body.platform &&
        this.connector.url === body.url;
      this.connector = {
        platform: body.platform,
        url: body.url,
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        importPolicies: body.importPolicies,
        enabled: same && this.connector !== null ? this.connector.enabled : false,
        lastStatus: this.connector?.lastStatus ?? null,
        lastRunAt: this.connector?.lastRunAt ?? null,
      };
      return json({ connector: this.connector });
    }
    if (route === 'DELETE /v1/admin/connector') {
      this.connector = null;
      return json({ connector: null });
    }
    if (
      route === 'POST /v1/admin/connector/preview' ||
      route === 'POST /v1/admin/connector/enable'
    ) {
      if (this.status !== 'active' || this.tier === null) {
        return json({ error: 'inactive' }, 409);
      }
      if (this.connector === null) {
        return json({ error: 'no_connector' }, 404);
      }
      if (route === 'POST /v1/admin/connector/preview') {
        return json({ result: this.previewResult });
      }
      this.connector.enabled = true;
      return json({ connector: this.connector });
    }
    return undefined;
  }

  /** A run is stored once enabled, seen on the next view read. */
  private runConnector(): void {
    if (this.connector?.enabled === true && this.runResult !== undefined) {
      this.connector.lastStatus = this.runResult;
      this.connector.lastRunAt = Math.max(Date.now(), (this.connector.lastRunAt ?? 0) + 1);
      this.runResult = undefined;
    }
  }

  private async overridden(call: Call): Promise<Response | undefined> {
    const route = `${call.method} ${call.path}`;
    for (const override of this.overrides) {
      if (override.route === route) {
        const answer = await override.handler(call);
        if (answer !== undefined) {
          return answer;
        }
      }
    }
    return undefined;
  }

  private async route(call: Call, origin: string | null): Promise<Response> {
    const route = `${call.method} ${call.path}`;
    if (route === 'POST /v1/session') {
      const queued = this.probeAnswers.shift();
      if (queued !== undefined) {
        return queued;
      }
      return origin === ORIGIN && this.status === 'active'
        ? json({ ticket: {}, assistant: this.assistant, branding: true })
        : json({ error: 'forbidden' }, 403);
    }
    if (route === 'POST /v1/admin/store') {
      if (this.owner === undefined) {
        throw new Error('no signer');
      }
      return json(this.view());
    }
    if (route === 'GET /v1/admin/store') {
      this.runConnector();
      return json(this.view());
    }
    if (route === 'GET /v1/admin/store/events') {
      return json({
        events: this.stored
          .filter((entry) => !entry.published && !entry.stopped)
          .map((entry) => entry.event),
        truncated: false,
      });
    }
    if (route === 'POST /v1/admin/store/events') {
      const body: { events: NostrEvent[] } = JSON.parse(JSON.stringify(call.body));
      for (const event of body.events) {
        if (
          event.kind === askr.KIND_CONFIG &&
          askr.parseConfig(event)?.assistant !== this.assistant
        ) {
          return json({ error: 'bad_event', reason: 'config_assistant', id: event.id }, 400);
        }
      }
      for (const event of body.events) {
        const known = this.stored.find((entry) => entry.event.id === event.id);
        if (known === undefined) {
          // A newer event of the same address replaces an unpublished one.
          const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
          this.stored = this.stored.filter(
            (entry) =>
              entry.published ||
              entry.event.kind !== event.kind ||
              entry.event.tags.find((tag) => tag[0] === 'd')?.[1] !== d,
          );
          this.stored.push({ event, published: false, stopped: false });
        } else {
          known.stopped = false;
        }
      }
      this.publish();
      return json({ stored: body.events.map((event) => event.id) });
    }
    if (route === 'POST /v1/admin/store/plan') {
      if (this.status === 'active') {
        return json({ ...this.view(), activation: 'already_active' });
      }
      if (this.status === 'suspended') {
        return json({ error: 'not_pending' }, 409);
      }
      if (this.tier !== null) {
        return json({ error: 'operator_managed' }, 409);
      }
      if (!this.stored.some((entry) => entry.event.kind === askr.KIND_CONFIG)) {
        return json({ error: 'no_settings' }, 409);
      }
      if (!this.freeAvailable) {
        return json({ error: 'free_unavailable' }, 409);
      }
      this.status = 'active';
      this.tier = FREE_TIER;
      this.publish();
      return json({ ...this.view(), activation: 'activated' });
    }
    if (route === 'POST /v1/admin/catalog') {
      return this.catalog(call);
    }
    const policy = /^\/v1\/admin\/policies\/([a-z0-9-]{1,64})$/.exec(call.path);
    if (policy?.[1] !== undefined && call.method === 'PUT') {
      if (this.status !== 'active') {
        return json({ error: 'inactive' }, 409);
      }
      const body: { title: string; body: string } = JSON.parse(JSON.stringify(call.body));
      const event = this.signedByK(
        askr.buildPolicyEvent({ slug: policy[1], title: body.title, body: body.body }),
      );
      this.relay.push(event);
      return json({ id: event.id });
    }
    return this.connectorRoute(call) ?? json({ error: 'not_found' }, 404);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    const call: Call = {
      method,
      path: url.pathname,
      body: bodyText === '' ? undefined : JSON.parse(bodyText),
    };
    this.calls.push(call);
    if (url.pathname.startsWith('/v1/admin/')) {
      const auth = decodeAuth(headers.get('authorization'));
      const u = auth?.tags.find((tag) => tag[0] === 'u')?.[1];
      const signedMethod = auth?.tags.find((tag) => tag[0] === 'method')?.[1];
      if (auth === undefined || u !== url.toString() || signedMethod !== method) {
        return json({ error: 'unauthorized', reason: 'url' }, 401);
      }
      // As the server's check: the SHA-256 of the exact body, and no payload tag without a body.
      const payload = auth.tags.find((tag) => tag[0] === 'payload')?.[1];
      const expected =
        bodyText === '' ? undefined : createHash('sha256').update(bodyText, 'utf8').digest('hex');
      if (payload !== expected) {
        return json({ error: 'unauthorized', reason: 'payload' }, 401);
      }
      if (this.authIds.has(auth.id)) {
        return json({ error: 'unauthorized', reason: 'replay' }, 401);
      }
      this.authIds.add(auth.id);
      call.authId = auth.id;
      const answer = await this.overridden(call);
      if (answer !== undefined) {
        return answer;
      }
      if (this.owner === undefined && method === 'POST' && url.pathname === '/v1/admin/store') {
        this.owner = auth.pubkey;
        return json(this.view());
      }
      if (this.owner !== auth.pubkey) {
        return json({ error: 'no_store' }, 404);
      }
    }
    if (!url.pathname.startsWith('/v1/admin/')) {
      const answer = await this.overridden(call);
      if (answer !== undefined) {
        return answer;
      }
    }
    return this.route(call, headers.get('origin'));
  };

  relayHandle(): RelayHandle {
    return {
      query: async (_relays: readonly string[], filter: Filter) =>
        this.relay.filter((event) => matchFilter(filter, event)),
      close: () => undefined,
    };
  }
}

export interface Harness {
  fake: FakeAskr;
  home: string;
  deps: AskrDeps;
  stderr: string[];
  stdout: string[];
  exits: number[];
  run: (invocation: AskrInvocation, args: string[], profile?: string) => Promise<CommandOutcome>;
}

const HOMES: string[] = [];

export async function cleanupHomes(): Promise<void> {
  while (HOMES.length > 0) {
    const home = HOMES.pop();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
    }
  }
}

/** Run `work` to its end under fake timers, jumping to each timer once nothing else is pending. */
export async function drive<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!settled && vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    }
  }
  return work;
}

export async function harness(
  fake: FakeAskr = new FakeAskr(),
  sharedHome?: string,
): Promise<Harness> {
  const home = sharedHome ?? (await mkdtemp(join(tmpdir(), 'elisym-askr-cli-')));
  HOMES.push(home);
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exits: number[] = [];
  const deps: AskrDeps = {
    fetch: fake.fetch,
    connectRelay: async () => fake.relayHandle(),
    now: () => Date.now(),
    home,
    env: { ELISYM_ASKR_API: BASE, ELISYM_ASKR_RELAY: RELAY },
    notice: (line) => stderr.push(line),
  };
  const run = (invocation: AskrInvocation, args: string[], profile?: string) =>
    drive(
      runAskrCommand(
        invocation,
        { ...(profile === undefined ? {} : { profile }), args },
        {
          loadAskr: async () => askr,
          deps: () => deps,
          io: {
            write: (line, flushed) => {
              stdout.push(line);
              flushed();
            },
            exit: (code) => exits.push(code),
          },
          hasWebSocket: () => true,
        },
      ),
    );
  return { fake, home, deps, stderr, stdout, exits, run };
}

export const INIT_ARGS = ['init', '--name', 'Example Shop', '--origin', ORIGIN];

export function initInvocation(extra: Partial<InitOptions> = {}): AskrInvocation {
  return {
    command: 'init',
    options: { name: 'Example Shop', origin: [ORIGIN], ...extra },
  };
}

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'elisym-askr-files-'));
  HOMES.push(dir);
  return dir;
}

export function product(d: string, extra: Partial<CatalogItemInput> = {}): CatalogItemInput {
  return {
    d,
    title: `Product ${d}`,
    price: { amount: '10', currency: 'EUR' },
    url: `${ORIGIN}/p/${d}`,
    ...extra,
  };
}

/** A store set up as the prompt does it: init, then Free. */
export async function activeStore(
  extra: Parameters<typeof initInvocation>[0] = {},
): Promise<Harness> {
  const setup = await harness();
  const init = await setup.run(initInvocation({ currency: 'EUR', ...extra }), INIT_ARGS);
  expect(init.exitCode).toBe(0);
  const plan = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
  expect(plan.exitCode).toBe(0);
  return setup;
}

export async function writeJson(items: unknown): Promise<string> {
  const path = join(await tempDir(), 'products.json');
  await writeFile(path, JSON.stringify(items));
  return path;
}

export async function writeCsv(text: string): Promise<string> {
  const path = join(await tempDir(), 'products.csv');
  await writeFile(path, text);
  return path;
}
