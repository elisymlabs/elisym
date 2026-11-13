import { createHash } from 'node:crypto';
import type { Db } from '../db/db';

/** Where pinned bundles are served: `/widget/<id>.js`, never changing (6). */
export const PINNED_WIDGET_PREFIX = '/widget/';
/** Hex characters of the SHA-384 a pinned path carries: 128 bits, no collision in practice. */
const PINNED_ID_CHARS = 32;
const PINNED_PATH_RE = /^\/widget\/([0-9a-f]{32})\.js$/;
/** Earlier bundles kept in memory once read, first in first out; each is a few hundred KB at most. */
export const MAX_CACHED_VERSIONS = 16;
/**
 * Ids no server served are remembered this long, so a repeated miss costs no
 * query; short, as another instance of a newer release may record one.
 */
export const MISS_TTL_MS = 60_000;
/** ...and at most this many, first in first out. */
export const MAX_CACHED_MISSES = 256;

/** Drop the entry put in first once `map` holds `max`. */
function makeRoom<Value>(map: Map<string, Value>, max: number): void {
  if (map.size >= max) {
    const [first] = map.keys();
    if (first !== undefined) {
      map.delete(first);
    }
  }
}

/** One build of `widget.js` and the content-addressed path and SRI value it is pinned by. */
export interface WidgetBundle {
  script: string;
  /** The first 32 hex characters of the bundle's SHA-384. */
  id: string;
  /** `/widget/<id>.js` */
  path: string;
  /** `sha384-<base64>`, for a script tag's `integrity`. */
  integrity: string;
}

export function widgetBundle(script: string): WidgetBundle {
  const digest = createHash('sha384').update(script, 'utf8').digest();
  const id = digest.toString('hex').slice(0, PINNED_ID_CHARS);
  return {
    script,
    id,
    path: `${PINNED_WIDGET_PREFIX}${id}.js`,
    integrity: `sha384-${digest.toString('base64')}`,
  };
}

/** The id a pinned widget path names, or undefined for any other path. */
export function pinnedIdOf(pathname: string): string | undefined {
  return PINNED_PATH_RE.exec(pathname)?.[1];
}

/** An earlier bundle looked up: found, never served, or not looked up as the caller may not query now. */
export type EarlierWidget =
  | { state: 'found'; script: string }
  | { state: 'missing' }
  | { state: 'limited' };

const MISSING: EarlierWidget = { state: 'missing' };

/**
 * Every bundle a server has served, in the database (6): a store that pinned
 * a version keeps getting exactly it after a release, from any instance.
 */
export class WidgetVersions {
  private readonly cache = new Map<string, string>();
  /** Missed ids and when (unix ms) they may be looked up again. */
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Keep the bundle this server serves; an id already kept stays as first recorded. */
  async record(bundle: WidgetBundle, now: number): Promise<void> {
    await this.db.query(
      `insert into widget_versions (id, script, first_served_at) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [bundle.id, bundle.script, now],
    );
  }

  /**
   * The script kept under `id`. Answered from memory when it can be; only a
   * lookup that reaches the database asks `mayQuery` first (a per-IP limit),
   * so a bundle already read is never limited.
   */
  async script(id: string, mayQuery: () => boolean = () => true): Promise<EarlierWidget> {
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return { state: 'found', script: cached };
    }
    const retryAt = this.misses.get(id);
    if (retryAt !== undefined && retryAt > this.nowMs()) {
      return MISSING;
    }
    if (!mayQuery()) {
      return { state: 'limited' };
    }
    this.misses.delete(id);
    const [row] = await this.db.query<{ script: string }>(
      'select script from widget_versions where id = $1',
      [id],
    );
    if (row === undefined) {
      makeRoom(this.misses, MAX_CACHED_MISSES);
      this.misses.set(id, this.nowMs() + MISS_TTL_MS);
      return MISSING;
    }
    makeRoom(this.cache, MAX_CACHED_VERSIONS);
    this.cache.set(id, row.script);
    return { state: 'found', script: row.script };
  }
}
