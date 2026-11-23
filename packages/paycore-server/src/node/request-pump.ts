/**
 * What makes the holder apply admin requests: a NOTIFY on the requests
 * channel (an admin route queued one) and a poll every `REQUEST_POLL_SECS`
 * (a notify lost while the listen connection was down, a request kept pending
 * by a failure, the suspension clocks, the periodic drift and offer checks). Rounds never overlap: a trigger during
 * a round runs one more round after it.
 */
import { type Db, REQUESTS_CHANNEL } from '../db/db';
import type { HolderRequests } from './holder-requests';

/** The poll period of the request pump. */
export const REQUEST_POLL_MS = 60_000;

export interface RequestPumpDeps {
  db: Pick<Db, 'listen'>;
  holder: Pick<HolderRequests, 'drainAll' | 'tick'>;
  pollMs?: number;
  log?: (message: string) => void;
}

export class RequestPump {
  private timer: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private tickAgain = false;
  private stopped = false;

  constructor(private readonly deps: RequestPumpDeps) {}

  /** LISTEN, start the poll, and run a first round (with the suspension tick). */
  async start(): Promise<void> {
    this.stopped = false;
    this.unlisten = await this.deps.db.listen(REQUESTS_CHANNEL, () => {
      this.kick(false);
    });
    this.timer = setInterval(() => {
      this.kick(true);
    }, this.deps.pollMs ?? REQUEST_POLL_MS);
    this.kick(true);
  }

  /** Stop listening and polling; resolves once the round in progress ends. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.unlisten?.();
    this.unlisten = undefined;
    await this.running;
  }

  /** Run one round now (or right after the one in progress); `tick` also runs the suspension clocks. */
  kick(tick: boolean): Promise<void> {
    this.tickAgain ||= tick;
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.running = this.rounds().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async rounds(): Promise<void> {
    do {
      this.again = false;
      const tick = this.tickAgain;
      this.tickAgain = false;
      if (this.stopped) {
        return;
      }
      await this.round(tick);
    } while (this.again);
  }

  private async round(tick: boolean): Promise<void> {
    const log = this.deps.log ?? ((message: string) => console.error(message));
    try {
      await this.deps.holder.drainAll();
    } catch (error) {
      log(`request round failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    if (!tick) {
      return;
    }
    try {
      await this.deps.holder.tick();
    } catch (error) {
      log(`periodic round failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}
