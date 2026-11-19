import type { ServerPool } from './relay/pool';
import { messageOf, publishToRelay } from './relay/publish';
import { MAX_PUBLISH_ATTEMPTS, type StoreDirectory } from './state/stores';

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
