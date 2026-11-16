import type { Queryable } from '../db/db';

/**
 * The sites a store has listed, and which of them may prove an owner key
 * replacement (K21, 1.6).
 */

/** How long a store must have had a site before it proves a replacement. */
export const ORIGIN_PROOF_AGE_SECS = 72 * 60 * 60;
/**
 * How long after a config last listed a site it still proves a replacement:
 * enough for an owner whose site a thief dropped from the settings, short
 * enough that a domain the owner let go cannot be bought to take the store.
 */
export const ORIGIN_DROPPED_GRACE_SECS = 30 * 24 * 60 * 60;
/**
 * Sites one replacement reads at most: the ones the store has had longest,
 * so sites a thief added later can never crowd out the owner's.
 */
export const MAX_PROOF_ORIGINS = 10;
/**
 * Sites a store keeps on record at most. Only ones that may still prove a
 * replacement count: older ones are dropped first, so junk a thief listed
 * never keeps the owner's later sites off the record.
 */
export const MAX_ORIGINS_HELD = 100;
/**
 * Hosts where anyone can claim a name another let go (preview deployments,
 * free subdomains of site builders and blogs): a site there never proves who
 * owns a store.
 */
export const SHARED_HOST_SUFFIXES: readonly string[] = [
  '.vercel.app',
  '.netlify.app',
  '.github.io',
  '.gitlab.io',
  '.pages.dev',
  '.workers.dev',
  '.web.app',
  '.firebaseapp.com',
  '.appspot.com',
  '.herokuapp.com',
  '.onrender.com',
  '.fly.dev',
  '.glitch.me',
  '.repl.co',
  '.surge.sh',
  '.ngrok.io',
  '.ngrok-free.app',
  '.azurewebsites.net',
  '.azurestaticapps.net',
  '.cloudfront.net',
  '.wordpress.com',
  '.wixsite.com',
  '.blogspot.com',
  '.webflow.io',
  '.weebly.com',
  '.squarespace.com',
  '.carrd.co',
  '.framer.app',
  '.framer.website',
  '.notion.site',
  '.tumblr.com',
  '.square.site',
  '.gumroad.com',
  '.bigcartel.com',
  '.godaddysites.com',
  '.jimdosite.com',
  '.mystrikingly.com',
  '.deno.dev',
  '.up.railway.app',
  '.r2.dev',
  '.amazonaws.com',
  '.elasticbeanstalk.com',
  '.azureedge.net',
  '.trafficmanager.net',
  '.cloudapp.net',
  '.replit.app',
  '.replit.dev',
  '.ghost.io',
  '.bitbucket.io',
  '.readthedocs.io',
  '.myportfolio.com',
];

export interface HeldOrigin {
  origin: string;
  /** Unix seconds, by the server's clock. */
  firstSeen: number;
  lastSeen: number;
}

/** Whether `origin` is on a shared host: its host name, without a final dot, ends in one. */
export function onSharedHost(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase().replace(/\.+$/u, '');
  return SHARED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The sites that may prove a replacement now: held for ORIGIN_PROOF_AGE_SECS,
 * listed within ORIGIN_DROPPED_GRACE_SECS (a served store's are noted again
 * every few hours), not on a shared host; the longest held first, at most MAX_PROOF_ORIGINS. With none,
 * when the first one will count, if any will.
 */
export function proofOrigins(
  held: readonly HeldOrigin[],
  now: number,
): { origins: string[]; readyAt: number | undefined } {
  const own = held.filter(
    (entry) => entry.lastSeen >= now - ORIGIN_DROPPED_GRACE_SECS && !onSharedHost(entry.origin),
  );
  const origins = own
    .filter((entry) => entry.firstSeen <= now - ORIGIN_PROOF_AGE_SECS)
    .sort(
      (left, right) => left.firstSeen - right.firstSeen || (left.origin < right.origin ? -1 : 1),
    )
    .slice(0, MAX_PROOF_ORIGINS)
    .map((entry) => entry.origin);
  const waiting = own.map((entry) => entry.firstSeen + ORIGIN_PROOF_AGE_SECS);
  return {
    origins,
    readyAt: origins.length > 0 || waiting.length === 0 ? undefined : Math.min(...waiting),
  };
}

/**
 * Record the origins a config of `owner` lists, each from when first seen and
 * until last seen (`now`, unix seconds by the server's clock). Sites past the
 * grace period are forgotten first, so the cap counts only live ones.
 */
export async function noteOrigins(
  db: Queryable,
  owner: string,
  origins: readonly string[],
  now: number,
): Promise<void> {
  if (origins.length === 0) {
    return;
  }
  const fresh = [...new Set(origins)];
  // A site listed again keeps its first sighting, however long the store was quiet.
  await db.query(
    `delete from store_origins
     where owner = $1 and last_seen < $2 and not (origin = any($3::text[]))`,
    [owner, now - ORIGIN_DROPPED_GRACE_SECS, fresh],
  );
  await db.query(
    `insert into store_origins (owner, origin, first_seen, last_seen)
     select $1, noted.value, $3, $3 from unnest($2::text[]) as noted(value)
     where exists (select 1 from stores where owner = $1)
       and (exists (select 1 from store_origins held where held.owner = $1 and held.origin = noted.value)
         or (select count(*) from store_origins held where held.owner = $1) < $4)
     on conflict (owner, origin) do update set
       last_seen = greatest(store_origins.last_seen, excluded.last_seen)`,
    [owner, fresh, now, MAX_ORIGINS_HELD],
  );
}
