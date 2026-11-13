import { createHash } from 'node:crypto';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { WIDGET_INFO_PATH, type WidgetSource, createGateway } from '../src/gateway/gateway';
import {
  type EarlierWidget,
  MAX_CACHED_MISSES,
  MAX_CACHED_VERSIONS,
  MISS_TTL_MS,
  WidgetVersions,
  pinnedIdOf,
  widgetBundle,
} from '../src/gateway/widget';
import { NOW, stateWith, storeRecord, syntheticStore } from './fixtures';
import { freshDb } from './pglite-db';

const SCRIPT = '(()=>{customElements.define("askr-chat",class extends HTMLElement{})})();';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** What a browser computes for `integrity`: the SHA-384 of the bytes it received. */
async function sriOf(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

function scriptOf(lookup: EarlierWidget): string | undefined {
  return lookup.state === 'found' ? lookup.script : undefined;
}

/** An earlier-bundle source as a database is: every lookup is a query, asked for first. */
function queried(find: (id: string) => string | undefined): WidgetSource['earlier'] {
  return async (id, mayQuery) => {
    if (!mayQuery()) {
      return { state: 'limited' };
    }
    const script = find(id);
    return script === undefined ? { state: 'missing' } : { state: 'found', script };
  };
}

async function gatewayWith(widget: WidgetSource | undefined) {
  const { state } = await stateWith([storeRecord(syntheticStore())]);
  const handler = createGateway({
    state,
    gatewaySecretKey: generateSecretKey(),
    configFor: () => undefined,
    isListed: () => false,
    isUnservable: () => false,
    reserveUsd: '0.25',
    ...(widget === undefined ? {} : { widget }),
  });
  return (path: string, method = 'GET') =>
    handler({
      request: new Request(`http://localhost${path}`, { method }),
      clientAddress: '203.0.113.7',
    });
}

describe('pinned widget bundles (6)', () => {
  it('a bundle is pinned by its SHA-384: the path carries its first 128 bits, integrity all of it', () => {
    const bundle = widgetBundle(SCRIPT);
    const digest = createHash('sha384').update(SCRIPT).digest();
    expect(bundle.integrity).toBe(`sha384-${digest.toString('base64')}`);
    expect(bundle.id).toBe(digest.toString('hex').slice(0, 32));
    expect(bundle.path).toBe(`/widget/${bundle.id}.js`);
    expect(pinnedIdOf(bundle.path)).toBe(bundle.id);
    expect(widgetBundle(`${SCRIPT} `).id).not.toBe(bundle.id);
  });

  it('only a lowercase 32-character hex name is a pinned path', () => {
    const id = 'a'.repeat(32);
    expect(pinnedIdOf(`/widget/${id}.js`)).toBe(id);
    for (const path of [
      `/widget/${'A'.repeat(32)}.js`,
      `/widget/${'a'.repeat(31)}.js`,
      `/widget/${'a'.repeat(33)}.js`,
      `/widget/${id}.js.map`,
      `/widget/${id}`,
      `/widgets/${id}.js`,
      `/x/widget/${id}.js`,
      '/widget.js',
    ]) {
      expect(pinnedIdOf(path)).toBeUndefined();
    }
  });

  it('serves the current bundle at its pinned path for good, readable cross-origin, matching its integrity', async () => {
    const bundle = widgetBundle(SCRIPT);
    const get = await gatewayWith({ current: bundle, earlier: queried(() => undefined) });
    const pinned = await get(bundle.path);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(pinned.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(pinned.headers.get('access-control-allow-origin')).toBe('*');
    expect(pinned.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(pinned.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await sriOf(pinned)).toBe(bundle.integrity);
    // The moving path keeps its short cache.
    const moving = await get('/widget.js');
    expect(moving.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await moving.text()).toBe(SCRIPT);
  });

  it('tells the admin the current pinned path and integrity', async () => {
    const bundle = widgetBundle(SCRIPT);
    const get = await gatewayWith({ current: bundle, earlier: queried(() => undefined) });
    const info = await get(WIDGET_INFO_PATH);
    expect(info.status).toBe(200);
    expect(info.headers.get('cache-control')).toBe('no-cache');
    expect(await info.json()).toEqual({ path: bundle.path, integrity: bundle.integrity });
    expect((await get(WIDGET_INFO_PATH, 'POST')).status).toBe(404);
  });

  it('serves an earlier bundle by its id, and nothing for an id no server served', async () => {
    const earlier = widgetBundle('/* the last release */');
    const current = widgetBundle(SCRIPT);
    const asked: string[] = [];
    const get = await gatewayWith({
      current,
      earlier: queried((id) => {
        asked.push(id);
        return id === earlier.id ? earlier.script : undefined;
      }),
    });
    const old = await get(earlier.path);
    expect(old.status).toBe(200);
    expect(old.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(await sriOf(old)).toBe(earlier.integrity);
    expect((await get(`/widget/${'0'.repeat(32)}.js`)).status).toBe(404);
    // The current bundle is served from memory, and a path that is no pinned id is never looked up.
    await get(current.path);
    await get(`/widget/${'A'.repeat(32)}.js`);
    expect(asked).toEqual([earlier.id, '0'.repeat(32)]);
  });

  it('serves no widget path at all without a widget', async () => {
    const get = await gatewayWith(undefined);
    const bundle = widgetBundle(SCRIPT);
    for (const path of ['/widget.js', bundle.path, WIDGET_INFO_PATH]) {
      expect((await get(path)).status).toBe(404);
    }
  });
});

describe('widget versions in the database (6)', () => {
  it('keeps every bundle a server served, so a pinned path outlives the release after it', async () => {
    const db = await freshDb();
    const first = widgetBundle('/* release 1 */');
    const second = widgetBundle('/* release 2 */');
    await new WidgetVersions(db).record(first, NOW);
    // The next release starts another server process on the same database.
    const versions = new WidgetVersions(db);
    await versions.record(second, NOW + 86_400);
    expect(scriptOf(await versions.script(first.id))).toBe(first.script);
    expect(scriptOf(await versions.script(second.id))).toBe(second.script);
    expect(scriptOf(await versions.script('0'.repeat(32)))).toBeUndefined();
    const get = await gatewayWith({
      current: second,
      earlier: (id, mayQuery) => versions.script(id, mayQuery),
    });
    expect(await (await get(first.path)).text()).toBe(first.script);
    expect(await (await get(second.path)).text()).toBe(second.script);
  });

  it('recording a bundle again keeps its first record', async () => {
    const db = await freshDb();
    const bundle = widgetBundle(SCRIPT);
    await new WidgetVersions(db).record(bundle, NOW);
    await new WidgetVersions(db).record(bundle, NOW + 10);
    const rows = await db.query<{ first_served_at: number; script: string }>(
      'select first_served_at, script from widget_versions',
    );
    expect(rows).toEqual([{ first_served_at: NOW, script: SCRIPT }]);
  });

  it('reads a version from the database once, then from memory', async () => {
    const db = await freshDb();
    const bundle = widgetBundle(SCRIPT);
    await new WidgetVersions(db).record(bundle, NOW);
    const versions = new WidgetVersions(db);
    expect(scriptOf(await versions.script(bundle.id))).toBe(SCRIPT);
    await db.query('delete from widget_versions');
    expect(scriptOf(await versions.script(bundle.id))).toBe(SCRIPT);
    expect(scriptOf(await new WidgetVersions(db).script(bundle.id))).toBeUndefined();
  });

  it('keeps a bounded number of versions in memory, first in first out by first read', async () => {
    const db = await freshDb();
    const bundles = Array.from({ length: MAX_CACHED_VERSIONS + 1 }, (_unused, index) =>
      widgetBundle(`/* release ${index} */`),
    );
    const versions = new WidgetVersions(db);
    for (const bundle of bundles) {
      await versions.record(bundle, NOW);
      scriptOf(await versions.script(bundle.id));
    }
    await db.query('delete from widget_versions');
    const [oldest] = bundles;
    const newest = bundles.at(-1);
    expect(scriptOf(await versions.script(oldest?.id ?? ''))).toBeUndefined();
    expect(scriptOf(await versions.script(newest?.id ?? ''))).toBe(newest?.script);
    expect(scriptOf(await versions.script(bundles[1]?.id ?? ''))).toBe(bundles[1]?.script);
  });

  it('remembers a missed id for a short while, so repeated misses cost no query', async () => {
    const db = await freshDb();
    const clock = { now: 1_000_000 };
    const versions = new WidgetVersions(db, () => clock.now);
    const bundle = widgetBundle(SCRIPT);
    expect(scriptOf(await versions.script(bundle.id))).toBeUndefined();
    // Recorded meanwhile (another instance of a newer release): the miss holds until its time is up.
    await new WidgetVersions(db).record(bundle, NOW);
    expect(scriptOf(await versions.script(bundle.id))).toBeUndefined();
    clock.now += MISS_TTL_MS - 1;
    expect(scriptOf(await versions.script(bundle.id))).toBeUndefined();
    clock.now += 1;
    expect(scriptOf(await versions.script(bundle.id))).toBe(SCRIPT);
  });

  it('remembers a bounded number of misses, first in first out', async () => {
    const db = await freshDb();
    const versions = new WidgetVersions(db, () => 0);
    const ids = Array.from({ length: MAX_CACHED_MISSES + 1 }, (_unused, index) =>
      index.toString(16).padStart(32, '0'),
    );
    for (const id of ids) {
      expect(scriptOf(await versions.script(id))).toBeUndefined();
    }
    const first = ids[0] ?? '';
    const second = ids[1] ?? '';
    await db.query(
      `insert into widget_versions (id, script, first_served_at) values ($1, 'first', 0), ($2, 'second', 0)`,
      [first, second],
    );
    // The first miss was dropped to make room: it is looked up again; the second is still remembered.
    expect(scriptOf(await versions.script(first))).toBe('first');
    expect(scriptOf(await versions.script(second))).toBeUndefined();
  });
});

describe('widget paths for HEAD and under load (6)', () => {
  it('answers HEAD on every widget path like GET, without a body', async () => {
    const earlier = widgetBundle('/* the last release */');
    const current = widgetBundle(SCRIPT);
    const get = await gatewayWith({
      current,
      earlier: queried((id) => (id === earlier.id ? earlier.script : undefined)),
    });
    for (const path of ['/widget.js', current.path, earlier.path, WIDGET_INFO_PATH]) {
      const head = await get(path, 'HEAD');
      const full = await get(path);
      expect(head.status).toBe(200);
      expect([...head.headers]).toEqual([...full.headers]);
      expect(await head.text()).toBe('');
    }
    expect((await get(`/widget/${'0'.repeat(32)}.js`, 'HEAD')).status).toBe(404);
  });

  it('limits database lookups of earlier bundles per IP, never one in memory nor the current one', async () => {
    const db = await freshDb();
    const current = widgetBundle(SCRIPT);
    const earlier = widgetBundle('/* the last release */');
    const versions = new WidgetVersions(db);
    await versions.record(earlier, NOW);
    const { state } = await stateWith([storeRecord(syntheticStore())]);
    const handler = createGateway({
      state,
      gatewaySecretKey: generateSecretKey(),
      configFor: () => undefined,
      isListed: () => false,
      isUnservable: () => false,
      reserveUsd: '0.25',
      now: () => NOW,
      widget: { current, earlier: (id, mayQuery) => versions.script(id, mayQuery) },
    });
    const get = (path: string, clientAddress = '203.0.113.7') =>
      handler({ request: new Request(`http://localhost${path}`), clientAddress });
    // Many browsers behind one address on a pinned earlier bundle: read once, then from memory.
    for (let index = 0; index < 200; index += 1) {
      expect((await get(earlier.path)).status).toBe(200);
      expect((await get(current.path)).status).toBe(200);
    }
    // Each of these misses reaches the database: the first lookup above was one too.
    const missing = (index: number) => `/widget/${index.toString(16).padStart(32, '0')}.js`;
    for (let index = 0; index < 59; index += 1) {
      expect((await get(missing(index))).status).toBe(404);
    }
    expect((await get(missing(59))).status).toBe(429);
    // A remembered miss costs no query, so it is not limited either.
    expect((await get(missing(0))).status).toBe(404);
    expect((await get(earlier.path)).status).toBe(200);
    expect((await get(missing(60), '198.51.100.4')).status).toBe(404);
  });
});
