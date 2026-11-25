/**
 * Republishing owner events (sub-plan step 11): an owner event the setup pass
 * recorded but no default relay took yet (`recorded` and `published_at is
 * null`) is published again with backoff until one does. An event never
 * recorded is never published here: its first publish is always a setup pass,
 * which records its terms in the ledger when it goes out. Only the newest
 * event of its kind is sent (relays keep the newest of a replaceable kind).
 *
 * It also publishes a moved store's revocation of its former owner's 30490
 * (`store_moves.revocation`), only once the store's latest move switched
 * (buyers read the new owner's events and profile), authenticated as the
 * store's S, with the same backoff until a default relay takes it.
 */
import { OFFER_RELAYS, PUBLISH_DEADLINE_MS } from '@merchant-node/constants';
import { type PublishPool, publishToRelays } from '@merchant-node/publish';
import { storeAuth } from '@merchant-node/store-node';
import type { NostrEvent } from 'nostr-tools';
import { ALERT_KINDS, clearAlert, raiseAlert } from './alerts';
import type { Db } from './db/db';
import type { KeyVault } from './db/keys';
import { allowedInboxRelays } from './node/load';
import { controlBackoffMs } from './node/start-checks';

/** How many events one round republishes at most. */
export const PUBLISH_BATCH = 20;

export interface PublisherPool extends PublishPool {
  destroy(): void;
}

export interface OwnerEventPublisherDeps {
  db: Db;
  vault: KeyVault;
  /** A fresh pool per event: relays authenticate a connection as one store key (P8). */
  makePool: () => PublisherPool;
  /** Where offers go besides the inbox relays (default: merchant-node's `OFFER_RELAYS`). */
  offerRelays?: readonly string[];
  /** `PAYCORE_INBOX_RELAYS` (P7): a stored inbox relay outside it is never connected to. */
  inboxRelayAllowlist: readonly string[];
  log?: (message: string) => void;
  /** Seconds. */
  now: () => number;
  /** A relay's answer deadline (merchant-node's default when absent). */
  deadlineMs?: number;
}

interface DueRow extends Record<string, unknown> {
  id: string;
  owner: string;
  event: NostrEvent | string;
  publish_attempts: number;
  store_key: Uint8Array;
  inbox_relays: string[];
}

interface DueRevocation extends Record<string, unknown> {
  id: number;
  owner: string;
  revocation: NostrEvent | string;
  publish_attempts: number;
  store_key: Uint8Array;
  inbox_relays: string[];
}

/** Where one send went: a default relay took it, none did, or it was not sent (inbox relays refused). */
type SendOutcome = 'published' | 'missed' | 'refused';

export class OwnerEventPublisher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(private readonly deps: OwnerEventPublisherDeps) {}

  /** Republish the events due now; resolves to how many were tried. One round at a time. */
  runOnce(): Promise<number> {
    this.running ??= this.round().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Run a round every `intervalMs` until `stop`. */
  start(intervalMs = 60_000): void {
    this.timer ??= setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.log(`publisher round failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => console.error(line)))(message);
  }

  private async round(): Promise<number> {
    const { db } = this.deps;
    const now = this.deps.now();
    const due = await db.query<DueRow>(
      `select e.id, e.owner, e.event, e.publish_attempts, k.store_key, c.inbox_relays
       from owner_events e
       join store_keys k on k.owner = e.owner
       join store_config c on c.owner = e.owner
       where e.recorded and e.published_at is null and e.next_attempt_at <= $1
         and not exists (
           select 1 from owner_events n
           where n.owner = e.owner and n.kind = e.kind
             and (n.event->>'created_at')::bigint > (e.event->>'created_at')::bigint)
       order by e.next_attempt_at, e.id limit $2`,
      [now, PUBLISH_BATCH],
    );
    for (const row of due) {
      await this.republish(row);
    }
    // A revocation waits for its store's latest move to switch: across chained moves too.
    const revocations = await db.query<DueRevocation>(
      `select m.id, s.owner, m.revocation, m.publish_attempts, k.store_key, c.inbox_relays
       from store_moves m
       join stores s on s.store_pubkey = m.store_pubkey
       join store_keys k on k.owner = s.owner
       join store_config c on c.owner = s.owner
       where m.revocation is not null and m.revocation_published_at is null
         and m.next_attempt_at <= $1
         and (select l.switched_at from store_moves l where l.store_pubkey = m.store_pubkey
              order by l.id desc limit 1) is not null
       order by m.next_attempt_at, m.id limit $2`,
      [now, PUBLISH_BATCH],
    );
    for (const row of revocations) {
      await this.publishRevocation(row);
    }
    return due.length + revocations.length;
  }

  private async republish(row: DueRow): Promise<void> {
    const { db } = this.deps;
    const event = typeof row.event === 'string' ? (JSON.parse(row.event) as NostrEvent) : row.event;
    const outcome = await this.send(row, event, `owner event ${row.id.slice(0, 12)}`);
    if (outcome === 'published') {
      await db.query(
        'update owner_events set published_at = $2 where id = $1 and published_at is null',
        [row.id, this.deps.now()],
      );
      return;
    }
    const attempts = row.publish_attempts + 1;
    await db.query(
      'update owner_events set publish_attempts = $2, next_attempt_at = $3 where id = $1',
      [row.id, attempts, this.nextAttemptAt(attempts)],
    );
  }

  private async publishRevocation(row: DueRevocation): Promise<void> {
    const { db } = this.deps;
    const event =
      typeof row.revocation === 'string'
        ? (JSON.parse(row.revocation) as NostrEvent)
        : row.revocation;
    const outcome = await this.send(row, event, `revocation of move ${row.id}`);
    if (outcome === 'published') {
      await db.query(
        `update store_moves set revocation_published_at = $2
         where id = $1 and revocation_published_at is null`,
        [row.id, this.deps.now()],
      );
      return;
    }
    const attempts = row.publish_attempts + 1;
    await db.query(
      'update store_moves set publish_attempts = $2, next_attempt_at = $3 where id = $1',
      [row.id, attempts, this.nextAttemptAt(attempts)],
    );
  }

  /** When attempt `attempts` + 1 is due (seconds). */
  private nextAttemptAt(attempts: number): number {
    return this.deps.now() + Math.ceil(controlBackoffMs(attempts - 1) / 1000);
  }

  /**
   * Send `event` to the offer relays and the store's allowlisted inbox
   * relays, authenticated as the store's S (opened for its current owner).
   */
  private async send(
    store: Pick<DueRow, 'owner' | 'store_key' | 'inbox_relays'>,
    event: NostrEvent,
    label: string,
  ): Promise<SendOutcome> {
    const { deps } = this;
    const { db } = deps;
    const offerRelays = deps.offerRelays ?? OFFER_RELAYS;
    let inboxRelays: string[];
    try {
      // The allowlist may have shrunk since the store was configured or imported (P7).
      inboxRelays = allowedInboxRelays(store.owner, store.inbox_relays, deps.inboxRelayAllowlist);
    } catch (error) {
      const problem = error instanceof Error ? error.message : 'inbox relays refused';
      this.log(`${label}: not published: ${problem}`);
      await raiseAlert(db, store.owner, ALERT_KINDS.inboxRelaysRefused, problem, {
        now: deps.now(),
        log: (line) => this.log(line),
      });
      return 'refused';
    }
    const relays = [...new Set([...offerRelays, ...inboxRelays])];
    let accepted: string[] = [];
    const pool = deps.makePool();
    try {
      const storeSecretKey = deps.vault.open(store.store_key, store.owner, 'store');
      accepted = await publishToRelays(
        pool,
        relays,
        event,
        storeAuth(storeSecretKey),
        (message) => this.log(`${label}: ${message}`),
        deps.deadlineMs ?? PUBLISH_DEADLINE_MS,
      );
    } catch (error) {
      this.log(`${label}: ${error instanceof Error ? error.message : 'not sent'}`);
    } finally {
      pool.destroy();
    }
    if (accepted.some((relay) => offerRelays.includes(relay))) {
      // The store's relays are back in the allowlist (or the allowlist grew back).
      await clearAlert(db, store.owner, ALERT_KINDS.inboxRelaysRefused, { now: deps.now() });
      return 'published';
    }
    return 'missed';
  }
}
