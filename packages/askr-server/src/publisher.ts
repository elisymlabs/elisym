import type { ServerPool } from './relay/pool';
import { MAX_PUBLISH_ATTEMPTS, type StoreDirectory } from './state/stores';

/**
 * Publish the stored O-signed events of active stores (7.3), marking each
 * published only once the relay accepted it, so a refused or failed publish
 * is retried, with a growing backoff, and no more after
 * `MAX_PUBLISH_ATTEMPTS` (logged, and shown in the admin; storing the event
 * again retries it). Runs are serialized.
 */
export class StoreEventPublisher {
  private running: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      directory: StoreDirectory;
      pool: Pick<ServerPool, 'publish'>;
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
        this.deps.log(
          `store event publish failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }),
    );
    return this.running;
  }

  private async publishPending(): Promise<void> {
    for (const { event } of await this.deps.directory.unpublishedEvents(this.now())) {
      try {
        await Promise.any(this.deps.pool.publish([this.deps.relayUrl], event));
      } catch {
        const failures = await this.deps.directory.markPublishFailed(event.id, this.now());
        this.deps.log(
          failures >= MAX_PUBLISH_ATTEMPTS
            ? `relay refused store event ${event.id} ${failures} times: no longer retried`
            : `relay refused store event ${event.id}`,
        );
        continue;
      }
      await this.deps.directory.markPublished(event.id);
    }
  }
}
