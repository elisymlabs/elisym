import type { ServerPool } from './relay/pool';
import type { StoreDirectory } from './state/stores';

/**
 * Publish the stored O-signed events of active stores (7.3), marking each
 * published only once the relay accepted it, so a refused or failed publish
 * is retried on the next run. Runs are serialized.
 */
export class StoreEventPublisher {
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      directory: StoreDirectory;
      pool: Pick<ServerPool, 'publish'>;
      relayUrl: string;
      log: (message: string) => void;
    },
  ) {}

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
    for (const { event } of await this.deps.directory.unpublishedEvents()) {
      try {
        await Promise.any(this.deps.pool.publish([this.deps.relayUrl], event));
        await this.deps.directory.markPublished(event.id);
      } catch {
        this.deps.log(`relay refused store event ${event.id}`);
      }
    }
  }
}
