/**
 * DM last-read cursors, per identity, in localStorage. Mirrors the MCP
 * read-cursor rule: the cursor moves to
 * `max(currentCursor, min(maxSeenCreatedAt, now))` - the inner clamp defuses
 * sender-controlled future timestamps, the outer max keeps the cursor
 * monotonic (a truncated or flaky relay fetch can return a maxSeen below the
 * stored cursor; writing it raw would resurrect phantom unread badges).
 *
 * The map is passed to SDK `listConversations` as `readCursors`, so the
 * badge uses the same `unreadCount` computation as MCP.
 */

const KEY_PREFIX = 'elisym:dm-read:';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export type ReadCursorMap = Record<string, number>;

const listeners = new Set<() => void>();
let version = 0;

function storageKey(identityPubkey: string): string {
  return `${KEY_PREFIX}${identityPubkey}`;
}

export function readCursors(identityPubkey: string): ReadCursorMap {
  try {
    const raw = localStorage.getItem(storageKey(identityPubkey));
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const map: ReadCursorMap = {};
    for (const [pubkey, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        map[pubkey] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** Returns true when the cursor actually moved forward. */
export function advanceReadCursor(
  identityPubkey: string,
  counterpartPubkey: string,
  maxSeenCreatedAt: number,
): boolean {
  // Mirrors the MCP write guard: only a 64-hex key and an integer >= 0 may
  // be persisted, whatever the caller passes - a garbage entry would sit in
  // localStorage forever.
  if (
    !HEX_PUBKEY_RE.test(counterpartPubkey) ||
    !Number.isInteger(maxSeenCreatedAt) ||
    maxSeenCreatedAt < 0
  ) {
    return false;
  }
  const nowSecs = Math.floor(Date.now() / 1000);
  const candidate = Math.min(maxSeenCreatedAt, nowSecs);
  const map = readCursors(identityPubkey);
  const current = map[counterpartPubkey];
  if (current !== undefined && current >= candidate) {
    return false;
  }
  map[counterpartPubkey] = candidate;
  try {
    localStorage.setItem(storageKey(identityPubkey), JSON.stringify(map));
  } catch {
    // Quota/private-mode failures degrade to "everything unread" - harmless.
  }
  version += 1;
  for (const listener of listeners) {
    listener();
  }
  return true;
}

/** Subscription surface for useSyncExternalStore. */
export function subscribeReadCursors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readCursorsVersion(): number {
  return version;
}
