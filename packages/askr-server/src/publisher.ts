import type { NostrEvent } from 'nostr-tools';
import { CONNECTION_TIMEOUT_MS } from './constants';
import type { ServerPool } from './relay/pool';
import { MAX_PUBLISH_ATTEMPTS, type StoreDirectory } from './state/stores';

/** nostr-tools' rejection when the relay sent no OK in time: no answer, not a refusal. */
const PUBLISH_TIMED_OUT = 'publish timed out';

export type PublishOutcome =
  | { status: 'accepted' }
  | { status: 'refused'; reason: string }
  | { status: 'unreachable'; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish one event to the relay and tell an explicit refusal (the relay's OK
 * false, with its reason) from a relay that could not be reached, dropped the
 * connection or did not answer in time.
 */
export async function publishToRelay(
  pool: Pick<ServerPool, 'ensureRelay'>,
  relayUrl: string,
  event: NostrEvent,
): Promise<PublishOutcome> {
  let relay;
  try {
    relay = await pool.ensureRelay(relayUrl, { connectionTimeout: CONNECTION_TIMEOUT_MS });
  } catch (error) {
    return { status: 'unreachable', reason: messageOf(error) };
  }
  try {
    await relay.publish(event);
    return { status: 'accepted' };
  } catch (error) {
    const reason = messageOf(error);
    // A connection that went away rejects every publish in flight with its close reason.
    if (!relay.connected || reason === PUBLISH_TIMED_OUT) {
      return { status: 'unreachable', reason };
    }
    return { status: 'refused', reason };
  }
}

/**
 * Publish the stored O-signed events of active stores (7.3), marking each
 * published only once the relay accepted it. A failed publish is retried with
 * a growing backoff; only the relay's explicit refusals count toward
 * `MAX_PUBLISH_ATTEMPTS`, past which the event is no longer retried (logged,
 * and shown in the admin; storing it again retries it). An unreachable relay
 * never stops an event: a run ends at the first one, and its events keep
 * being retried at the backoff's interval, however long the outage. Runs are
 * serialized.
 */
export class StoreEventPublisher {
  private running: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      directory: StoreDirectory;
      pool: Pick<ServerPool, 'ensureRelay'>;
      relayUrl: string;
      log: (message: string) => void;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  run(): Promise<void> {
    this.running = this.running.then(() =>
      this.publishPending().catch((error: unknown) => {
        this.deps.log(`store event publish failed: ${messageOf(error)}`);
      }),
    );
    return this.running;
  }

  private async publishPending(): Promise<void> {
    for (const { event } of await this.deps.directory.unpublishedEvents(this.now())) {
      const outcome = await publishToRelay(this.deps.pool, this.deps.relayUrl, event);
      if (outcome.status === 'accepted') {
        await this.deps.directory.markPublished(event.id);
        continue;
      }
      const refused = outcome.status === 'refused';
      const failures = await this.deps.directory.markPublishFailed(event.id, this.now(), refused);
      if (!refused) {
        this.deps.log(`relay unreachable for store event ${event.id}: ${outcome.reason}`);
        // The rest would meet the same relay: they wait for the next run.
        return;
      }
      this.deps.log(
        failures >= MAX_PUBLISH_ATTEMPTS
          ? `relay refused store event ${event.id} ${failures} times (${outcome.reason}): no longer retried`
          : `relay refused store event ${event.id}: ${outcome.reason}`,
      );
    }
  }
}
