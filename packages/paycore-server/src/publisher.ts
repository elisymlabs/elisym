/**
 * Republishing owner events (sub-plan step 11): an owner event the setup pass
 * recorded but no default relay took yet (`recorded` and `published_at is
 * null`) is published again with backoff until one does. An event never
 * recorded is never published here: its first publish is always a setup pass,
 * which records its terms in the ledger when it goes out. Only the newest
 * event of its kind is sent (relays keep the newest of a replaceable kind).
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
    return due.length;
  }

  private async republish(row: DueRow): Promise<void> {
    const { deps } = this;
    const { db } = deps;
    const offerRelays = deps.offerRelays ?? OFFER_RELAYS;
    const event = typeof row.event === 'string' ? (JSON.parse(row.event) as NostrEvent) : row.event;
    let inboxRelays: string[];
    try {
      // The allowlist may have shrunk since the store was configured or imported (P7).
      inboxRelays = allowedInboxRelays(row.owner, row.inbox_relays, deps.inboxRelayAllowlist);
    } catch (error) {
      const problem = error instanceof Error ? error.message : 'inbox relays refused';
      this.log(`owner event ${row.id.slice(0, 12)}: not published: ${problem}`);
      await raiseAlert(db, row.owner, ALERT_KINDS.inboxRelaysRefused, problem, {
        now: deps.now(),
        log: (line) => this.log(line),
      });
      await this.backOff(row);
      return;
    }
    const relays = [...new Set([...offerRelays, ...inboxRelays])];
    let accepted: string[] = [];
    const pool = deps.makePool();
    try {
      const storeSecretKey = deps.vault.open(row.store_key, row.owner, 'store');
      accepted = await publishToRelays(
        pool,
        relays,
        event,
        storeAuth(storeSecretKey),
        (message) => this.log(`owner event ${row.id.slice(0, 12)}: ${message}`),
        deps.deadlineMs ?? PUBLISH_DEADLINE_MS,
      );
    } catch (error) {
      this.log(
        `owner event ${row.id.slice(0, 12)}: ${error instanceof Error ? error.message : 'not sent'}`,
      );
    } finally {
      pool.destroy();
    }
    const now = deps.now();
    if (accepted.some((relay) => offerRelays.includes(relay))) {
      await db.query(
        'update owner_events set published_at = $2 where id = $1 and published_at is null',
        [row.id, now],
      );
      // The store's relays are back in the allowlist (or the allowlist grew back).
      await clearAlert(db, row.owner, ALERT_KINDS.inboxRelaysRefused, { now });
      return;
    }
    await this.backOff(row);
  }

  private async backOff(row: DueRow): Promise<void> {
    const now = this.deps.now();
    const attempts = row.publish_attempts + 1;
    await this.deps.db.query(
      'update owner_events set publish_attempts = $2, next_attempt_at = $3 where id = $1',
      [row.id, attempts, now + Math.ceil(controlBackoffMs(attempts - 1) / 1000)],
    );
  }
}
