import { createHash } from 'node:crypto';
import type { Db } from '../db/db';

/** Where pinned bundles are served: `/widget/<id>.js`, never changing (6). */
export const PINNED_WIDGET_PREFIX = '/widget/';
/** Hex characters of the SHA-384 a pinned path carries: 128 bits, no collision in practice. */
const PINNED_ID_CHARS = 32;
const PINNED_PATH_RE = /^\/widget\/([0-9a-f]{32})\.js$/;
/** Earlier bundles kept in memory once read; each is a few hundred KB at most. */
export const MAX_CACHED_VERSIONS = 16;

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

/**
 * Every bundle a server has served, in the database (6): a store that pinned
 * a version keeps getting exactly it after a release, from any instance.
 */
export class WidgetVersions {
  private readonly cache = new Map<string, string>();

  constructor(private readonly db: Db) {}

  /** Keep the bundle this server serves; an id already kept stays as first recorded. */
  async record(bundle: WidgetBundle, now: number): Promise<void> {
    await this.db.query(
      `insert into widget_versions (id, integrity, script, first_served_at) values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [bundle.id, bundle.integrity, bundle.script, now],
    );
  }

  /** The script kept under `id`, or undefined when no server ever served it. */
  async script(id: string): Promise<string | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.db.query<{ script: string }>(
      'select script from widget_versions where id = $1',
      [id],
    );
    if (row === undefined) {
      return undefined;
    }
    if (this.cache.size >= MAX_CACHED_VERSIONS) {
      const [oldest] = this.cache.keys();
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(id, row.script);
    return row.script;
  }
}
