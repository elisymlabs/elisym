import { ASKR_API_BASE } from '@elisym/askr';
import { HEX_PUBKEY_RE, isEventShaped } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';

export interface SessionGrant {
  ticket: NostrEvent;
  /** The assistant key A the gateway names: compared with the config's `assistant`. */
  assistant: string;
  /** False when the store's tier drops the "by Askr" line; absent means shown. */
  branding: boolean;
}

/**
 * `unavailable`: the gateway refused the store (not active, origin not
 * allowed, budget exhausted): the widget shows the unavailable state (3).
 * `error`: anything else (network, rate limit, a malformed reply): try later.
 */
export type SessionResult =
  | { kind: 'granted'; grant: SessionGrant }
  /** The store's owner key was replaced (K21): the client checks the new one before following. */
  | { kind: 'moved'; owner: string }
  | { kind: 'unavailable' }
  | { kind: 'error' };

/** What a handoff click was: a product link opened, or an add to cart pressed. */
export type ClickKind = 'link' | 'cart';

/** The Askr gateway (3). Injectable, so tests can drive grants and refusals. */
export interface Gateway {
  openSession: (store: string, visitor: string) => Promise<SessionResult>;
  /** Advisory handoff count; failures are ignored. */
  reportClick: (ticket: NostrEvent, address: string, kind: ClickKind) => Promise<void>;
}

/** HTTP statuses the gateway answers a refused store with. */
const REFUSED_STATUSES: readonly number[] = [403];

function readGrant(body: unknown): SessionGrant | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...body };
  const { ticket, assistant, branding } = record;
  if (!isEventShaped(ticket) || typeof assistant !== 'string' || !HEX_PUBKEY_RE.test(assistant)) {
    return undefined;
  }
  return { ticket, assistant, branding: branding !== false };
}

/** The new owner key a moved store's answer names, hex. */
function movedOwner(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const moved: unknown = Reflect.get(body, 'moved');
  return typeof moved === 'string' && HEX_PUBKEY_RE.test(moved) ? moved : undefined;
}

function saysUnavailable(body: unknown): boolean {
  return typeof body === 'object' && body !== null && Reflect.get(body, 'unavailable') === true;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return undefined;
  }
}

/** The gateway over `fetch`: `POST /v1/session` and `POST /v1/click` (3). */
export function httpGateway(
  base: string = ASKR_API_BASE,
  fetchImpl: typeof fetch = fetch,
): Gateway {
  return {
    async openSession(store, visitor) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/v1/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ store, visitor }),
          credentials: 'omit',
        });
      } catch {
        return { kind: 'error' };
      }
      const body = await readJson(response);
      const moved = movedOwner(body);
      if (moved !== undefined && moved !== store) {
        return { kind: 'moved', owner: moved };
      }
      if (saysUnavailable(body) || REFUSED_STATUSES.includes(response.status)) {
        return { kind: 'unavailable' };
      }
      const grant = response.ok ? readGrant(body) : undefined;
      return grant ? { kind: 'granted', grant } : { kind: 'error' };
    },
    async reportClick(ticket, address, kind) {
      try {
        await fetchImpl(`${base}/v1/click`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket, address, kind }),
          credentials: 'omit',
          keepalive: true,
        });
      } catch {
        return;
      }
    },
  };
}
