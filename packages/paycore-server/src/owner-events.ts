/**
 * Owner events (10133 payout list, 30490 hosted authorization) by prepare ->
 * sign -> commit: the server builds the exact unsigned template, the
 * merchant's browser signs it with O, and the server accepts only that very
 * event. A committed event is recorded in the ledger and published by the
 * store's holder (`record_owner_event`), never here.
 */
import { KIND_PAYTO, KIND_STORE_AUTH, parseCaip19, verifyPaytoProof } from '@elisym/commerce';
import { payoutListDate, clockProblem } from '@merchant-node/setup-ledger';
import { ownerEventTemplates } from '@merchant-node/store-events';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import * as z from 'zod';
import { insertRequest } from './admin/requests';
import type { Db, Queryable } from './db/db';
import { WINDING_DOWN_STATUSES } from './node/load';
import type { StoreStatus } from './state/leases';
import { parseLedger } from './state/ledger-store';
import { isSwitching } from './state/move-rows';
import { canonicalPayouts } from './state/stores';

/** A prepared template may be signed and committed within this long. */
export const DRAFT_TTL_SECS = 15 * 60;

export type OwnerEventKind = typeof KIND_PAYTO | typeof KIND_STORE_AUTH;
export const OWNER_EVENT_KINDS: readonly OwnerEventKind[] = [KIND_PAYTO, KIND_STORE_AUTH];

export interface OwnerEventDeps {
  db: Db;
  /** PAYCORE_OPERATOR: the 30490 `operator` (R2). */
  operator: string;
  now: () => number;
}

export interface RelaysNewest {
  /** `created_at` of the newest event of this kind by O the relays serve now, if any was read. */
  newestOnRelays?: number;
}

export type OwnerEventError =
  | 'no_store'
  | 'no_payouts'
  | 'unsigned_payout'
  | 'bad_payouts'
  | 'clock'
  | 'malformed'
  | 'signature'
  | 'author'
  | 'no_draft'
  | 'expired'
  | 'mismatch'
  | 'stale'
  | 'suspended'
  | 'switching';

export interface OwnerEventRefusal {
  ok: false;
  error: OwnerEventError;
  message?: string;
}

export type PrepareResult =
  | { ok: true; template: EventTemplate; expiresAt: number; payoutsString?: string }
  | OwnerEventRefusal;

export type CommitResult =
  | { ok: true; id: string; requestId: string | undefined; alreadyCommitted: boolean }
  | OwnerEventRefusal;

const HEX_RE = /^[0-9a-f]+$/;

/** A store winding down publishes nothing new: its listings are sold out for good. */
const WINDING_DOWN: OwnerEventRefusal = {
  ok: false,
  error: 'suspended',
  message: 'the store is suspended or being suspended: it takes no more owner events',
};

/**
 * A new payout list while the store switches to its new owner key: buyers
 * still read the former owner's terms, which a new list could replace.
 */
const SWITCHING: OwnerEventRefusal = {
  ok: false,
  error: 'switching',
  message: 'the store is switching to its new owner key: its payout list changes after that',
};

export const SignedEventSchema = z.object({
  id: z.string().length(64).regex(HEX_RE),
  pubkey: z.string().length(64).regex(HEX_RE),
  created_at: z.number().int().nonnegative(),
  kind: z.union([z.literal(KIND_PAYTO), z.literal(KIND_STORE_AUTH)]),
  tags: z.array(z.array(z.string().max(1024)).max(8)).max(64),
  content: z.string().max(1024),
  sig: z.string().length(128).regex(HEX_RE),
});

/** `created_at` of O's newest committed event of `kind` other than `exceptId`. */
async function newestCommitted(
  tx: Queryable,
  owner: string,
  kind: OwnerEventKind,
  exceptId?: string,
): Promise<number | undefined> {
  const [row] = await tx.query<{ created_at: number | null }>(
    `select max((event->>'created_at')::bigint) as created_at from owner_events
     where owner = $1 and kind = $2 and id <> $3`,
    [owner, kind, exceptId ?? ''],
  );
  return row?.created_at ?? undefined;
}

async function ledgerOf(tx: Queryable, owner: string) {
  const [row] = await tx.query<{ state: string }>('select state from ledgers where owner = $1', [
    owner,
  ]);
  return row === undefined ? undefined : parseLedger(row.state, owner);
}

/**
 * Build O's unsigned `kind` event and keep it as the store's draft of that
 * kind (one per kind; a new prepare replaces it). 10133: the draft payouts
 * (each wallet-signed), dated by `payoutListDate` against the ledger's
 * `state.payto` and the relays' newest - an unchanged list keeps its date -
 * and never at or before another committed list; the exact draft payouts
 * string is kept with it (P9). 30490: `mode: hosted`, the operator, no expiry
 * (R2), dated after the last committed one.
 */
export async function prepareOwnerEvent(
  deps: OwnerEventDeps,
  owner: string,
  kind: OwnerEventKind,
  relays: RelaysNewest = {},
): Promise<PrepareResult> {
  const now = deps.now();
  return deps.db.transaction(async (tx): Promise<PrepareResult> => {
    const [store] = await tx.query<{
      status: StoreStatus;
      store_pubkey: string;
      draft_payouts: unknown;
    }>(
      `select s.status, s.store_pubkey, c.draft_payouts from stores s
       join store_config c on c.owner = s.owner
       where s.owner = $1 for update of s`,
      [owner],
    );
    const state = await ledgerOf(tx, owner);
    if (store === undefined || state === undefined) {
      return { ok: false, error: 'no_store' };
    }
    if (WINDING_DOWN_STATUSES.includes(store.status)) {
      return WINDING_DOWN;
    }
    if (kind === KIND_PAYTO && (await isSwitching(tx, store.store_pubkey))) {
      return SWITCHING;
    }
    const lastCommitted = await newestCommitted(tx, owner, kind);
    let template: EventTemplate;
    let payoutsString: string | undefined;
    if (kind === KIND_PAYTO) {
      const draft =
        typeof store.draft_payouts === 'string'
          ? JSON.parse(store.draft_payouts)
          : store.draft_payouts;
      const canonical = canonicalPayouts(draft);
      if (canonical === undefined) {
        return { ok: false, error: 'no_payouts' };
      }
      const unsigned = canonical.list.find((payout) => {
        const caip19 = parseCaip19(payout.caip19);
        return (
          caip19 === undefined ||
          payout.signature === undefined ||
          !verifyPaytoProof({
            chain: caip19.chain,
            address: payout.address,
            ownerPubkey: owner,
            caip19: caip19.id,
            signature: payout.signature,
          })
        );
      });
      if (unsigned !== undefined) {
        return { ok: false, error: 'unsigned_payout', message: unsigned.caip19 };
      }
      payoutsString = canonical.text;
      const floor = Math.max(lastCommitted ?? 0, relays.newestOnRelays ?? 0);
      const kept = payoutListDate(state, payoutsString, relays.newestOnRelays, now);
      const keeps = state.payto !== undefined && kept === state.payto.createdAt && floor <= kept;
      const date = keeps ? kept : Math.max(kept, floor + 1);
      const problem = clockProblem('the payout list', date, now);
      if (problem !== undefined) {
        return { ok: false, error: 'clock', message: problem };
      }
      try {
        template = ownerEventTemplates(
          { payouts: canonical.list },
          owner,
          store.store_pubkey,
          date,
          now,
          {
            mode: 'hosted',
            operator: deps.operator,
          },
        ).payoutList;
      } catch {
        // A15: the builder's text names addresses and rules, never shown; the admin says it by code.
        return { ok: false, error: 'bad_payouts' };
      }
    } else {
      const date = Math.max(now, (lastCommitted ?? 0) + 1, (relays.newestOnRelays ?? 0) + 1);
      const problem = clockProblem('the store authorization', date, now);
      if (problem !== undefined) {
        return { ok: false, error: 'clock', message: problem };
      }
      template = ownerEventTemplates({ payouts: [] }, owner, store.store_pubkey, date, date, {
        mode: 'hosted',
        operator: deps.operator,
      }).authorization;
    }
    const expiresAt = now + DRAFT_TTL_SECS;
    await tx.query(
      `insert into owner_event_drafts (owner, kind, template, payouts_string, expires_at)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (owner, kind) do update set template = $3::jsonb, payouts_string = $4, expires_at = $5`,
      [owner, kind, JSON.stringify(template), payoutsString ?? null, expiresAt],
    );
    return {
      ok: true,
      template,
      expiresAt,
      ...(payoutsString === undefined ? {} : { payoutsString }),
    };
  });
}

/**
 * A new `record_owner_event` request for an unrecorded event, unless one is
 * pending already; undefined then. The payload text is compared as
 * `insertRequest` writes it (JSON text: a jsonb cast could fail on another
 * row's NUL escape).
 */
async function recordAgain(
  tx: Queryable,
  owner: string,
  eventId: string,
  now: number,
): Promise<string | undefined> {
  const payload = { eventId };
  const [pending] = await tx.query(
    `select 1 from admin_requests
     where owner = $1 and kind = 'record_owner_event' and state = 'pending' and payload = $2`,
    [owner, JSON.stringify(payload)],
  );
  return pending === undefined
    ? insertRequest(tx, owner, 'record_owner_event', payload, now)
    : undefined;
}

/** Whether `event` is `template` exactly (id, date, tags, content) as signed by `owner`. */
export function sameTemplate(event: NostrEvent, template: EventTemplate, owner: string): boolean {
  return (
    event.kind === template.kind &&
    event.created_at === template.created_at &&
    event.content === template.content &&
    JSON.stringify(event.tags) === JSON.stringify(template.tags) &&
    event.id === getEventHash({ ...template, pubkey: owner })
  );
}

/**
 * Accept O's signed draft: a valid signature by `owner`, byte-equal to the
 * prepared template (id, date, tags, content), before the draft expires, and
 * no newer event of its kind known - committed here or on the relays (a
 * 10133 dated as the relays' newest only when it keeps the ledger's recorded
 * date). Stored `recorded = false` with the draft's payouts string, and a
 * `record_owner_event` request queued for the holder. Committing the same
 * event again answers `alreadyCommitted`; when it is still unrecorded and no
 * request to record it is pending (the last one failed), a new one is queued.
 * Refused for a store winding down.
 */
export async function commitOwnerEvent(
  deps: OwnerEventDeps,
  owner: string,
  raw: unknown,
  relays: RelaysNewest = {},
): Promise<CommitResult> {
  const parsed = SignedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'malformed' };
  }
  const event: NostrEvent = parsed.data;
  if (!verifyEvent(event)) {
    return { ok: false, error: 'signature' };
  }
  if (event.pubkey !== owner) {
    return { ok: false, error: 'author' };
  }
  const kind = parsed.data.kind;
  const now = deps.now();
  return deps.db.transaction(async (tx): Promise<CommitResult> => {
    const [store] = await tx.query<{ status: StoreStatus; store_pubkey: string }>(
      'select status, store_pubkey from stores where owner = $1 for update',
      [owner],
    );
    const state = await ledgerOf(tx, owner);
    if (store === undefined || state === undefined) {
      return { ok: false, error: 'no_store' };
    }
    if (WINDING_DOWN_STATUSES.includes(store.status)) {
      return WINDING_DOWN;
    }
    if (kind === KIND_PAYTO && (await isSwitching(tx, store.store_pubkey))) {
      return SWITCHING;
    }
    const [known] = await tx.query<{ recorded: boolean }>(
      'select recorded from owner_events where id = $1 and owner = $2',
      [event.id, owner],
    );
    if (known !== undefined) {
      return {
        ok: true,
        id: event.id,
        requestId: known.recorded ? undefined : await recordAgain(tx, owner, event.id, now),
        alreadyCommitted: true,
      };
    }
    const [draft] = await tx.query<{
      template: unknown;
      payouts_string: string | null;
      expires_at: number;
    }>(
      'select template, payouts_string, expires_at from owner_event_drafts where owner = $1 and kind = $2',
      [owner, kind],
    );
    if (draft === undefined) {
      return { ok: false, error: 'no_draft' };
    }
    if (draft.expires_at <= now) {
      return { ok: false, error: 'expired' };
    }
    const template: EventTemplate =
      typeof draft.template === 'string' ? JSON.parse(draft.template) : draft.template;
    if (!sameTemplate(event, template, owner)) {
      return { ok: false, error: 'mismatch' };
    }
    const committed = await newestCommitted(tx, owner, kind, event.id);
    const keepsRecorded = kind === KIND_PAYTO && state.payto?.createdAt === event.created_at;
    const newest = relays.newestOnRelays;
    if (
      (committed !== undefined && committed >= event.created_at) ||
      (newest !== undefined &&
        (newest > event.created_at || (newest === event.created_at && !keepsRecorded)))
    ) {
      return { ok: false, error: 'stale' };
    }
    await tx.query(
      `insert into owner_events (id, owner, kind, event, payouts_string, committed_at)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [event.id, owner, kind, JSON.stringify(event), draft.payouts_string, now],
    );
    await tx.query('delete from owner_event_drafts where owner = $1 and kind = $2', [owner, kind]);
    const requestId = await insertRequest(
      tx,
      owner,
      'record_owner_event',
      { eventId: event.id },
      now,
    );
    return { ok: true, id: event.id, requestId, alreadyCommitted: false };
  });
}

/** O's committed event of one kind as the admin shows it (the newest by `created_at`). */
export interface CommittedOwnerEvent {
  /** The O-signed event: public once published, so the admin can post it back to commit (Retry). */
  event: NostrEvent;
  committedAt: number;
  /** When a default relay took it; null until then (or when its record request failed). */
  publishedAt: number | null;
}

export interface CommittedOwnerEvents {
  payto: CommittedOwnerEvent | null;
  auth: CommittedOwnerEvent | null;
  /** The 10133's canonical payouts string (P9), to compare with the draft. */
  paytoPayouts: string | undefined;
}

/** O's newest committed 10133 and 30490 (by event `created_at`, as `newestCommitted` judges). */
export async function committedOwnerEvents(
  db: Queryable,
  owner: string,
): Promise<CommittedOwnerEvents> {
  const rows = await db.query<{
    kind: number;
    event: NostrEvent | string;
    payouts_string: string | null;
    committed_at: number;
    published_at: number | null;
  }>(
    `select distinct on (kind) kind, event, payouts_string, committed_at, published_at
     from owner_events where owner = $1
     order by kind, (event->>'created_at')::bigint desc, committed_at desc`,
    [owner],
  );
  const of = (kind: OwnerEventKind) => rows.find((row) => row.kind === kind);
  const view = (row: (typeof rows)[number] | undefined): CommittedOwnerEvent | null =>
    row === undefined
      ? null
      : {
          event: typeof row.event === 'string' ? (JSON.parse(row.event) as NostrEvent) : row.event,
          committedAt: row.committed_at,
          publishedAt: row.published_at,
        };
  return {
    payto: view(of(KIND_PAYTO)),
    auth: view(of(KIND_STORE_AUTH)),
    paytoPayouts: of(KIND_PAYTO)?.payouts_string ?? undefined,
  };
}
