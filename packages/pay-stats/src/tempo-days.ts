/**
 * Tempo hours as block ranges.
 *
 * A Tempo block is about half a second, and timestamps repeat (~2 blocks a
 * second), so an hour `h` is `[lb(T_h), lb(T_h+1) - 1]` where `lb(T)` is the
 * FIRST block whose timestamp is at least `T`: consecutive hours then share no
 * block and skip none. An hour is ~6.5k blocks, inside the range one
 * `eth_getLogs` answers whole, so a scan of one hour is about one request.
 *
 * The boundaries are found once per run and shared by every token. Each search
 * starts from the previous boundary plus the last hour's length (with a
 * margin), widens until it brackets the target, then alternates interpolation
 * and bisection: a few block reads per hour.
 */
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { readBlockByNumber, readFinalizedBlock } from '@elisym/pay-core/evm';
import { utcDay } from './aggregate';

export const HOUR_SECS = 3600;
/** About 0.555 s a block on Tempo mainnet (measured 2026-10-14). */
const DEFAULT_BLOCKS_PER_HOUR = 6_500;
/** How much past the expected boundary the first probe looks. */
const PROBE_MARGIN = 1.25;
/** Reads of one block before the run gives up on the chain. */
const BLOCK_READ_ATTEMPTS = 3;

/** Block timestamps, read once each. */
export interface BlockClock {
  /** The timestamp of block `number`; throws when the chain cannot say. */
  timeOf(number: number): Promise<number>;
}

export function blockClock(client: Eip1193Client): BlockClock {
  const cache = new Map<number, number>();
  return {
    async timeOf(number: number): Promise<number> {
      const cached = cache.get(number);
      if (cached !== undefined) {
        return cached;
      }
      for (let attempt = 0; attempt < BLOCK_READ_ATTEMPTS; attempt += 1) {
        const block = await readBlockByNumber(client, number);
        if (block !== null) {
          cache.set(number, block.timestamp);
          return block.timestamp;
        }
      }
      throw new Error(`Tempo block ${number} could not be read`);
    },
  };
}

/** The finalized head; throws when it cannot be read. */
export async function finalizedHead(
  client: Eip1193Client,
): Promise<{ number: number; timestamp: number }> {
  const head = await readFinalizedBlock(client);
  if (head === null) {
    throw new Error('the Tempo finalized block could not be read');
  }
  return head;
}

/**
 * The first block at or below `head` whose timestamp is at least `target`, or
 * `head + 1` when there is none yet. `guess` is where to look first, `step`
 * how far to widen while bracketing.
 */
export async function firstBlockAtOrAfter(
  clock: BlockClock,
  target: number,
  head: number,
  guess: number,
  step: number,
): Promise<number> {
  if ((await clock.timeOf(head)) < target) {
    return head + 1;
  }
  if ((await clock.timeOf(0)) >= target) {
    return 0;
  }
  // Bracket: `low` before the target, `high` at or after it.
  let probe = Math.min(Math.max(guess, 0), head);
  let width = Math.max(1, Math.floor(step));
  let low = 0;
  let high = head;
  if ((await clock.timeOf(probe)) >= target) {
    high = probe;
    for (;;) {
      const below = Math.max(0, high - width);
      if ((await clock.timeOf(below)) < target) {
        low = below;
        break;
      }
      high = below;
      width *= 2;
    }
  } else {
    low = probe;
    for (;;) {
      const above = Math.min(head, low + width);
      if ((await clock.timeOf(above)) >= target) {
        high = above;
        break;
      }
      low = above;
      width *= 2;
    }
  }
  // Narrow: interpolation and bisection in turn, so a skewed clock still converges.
  let interpolate = true;
  while (high - low > 1) {
    const lowTime = await clock.timeOf(low);
    const highTime = await clock.timeOf(high);
    let middle = Math.floor((low + high) / 2);
    if (interpolate && highTime > lowTime) {
      const share = (target - lowTime) / (highTime - lowTime);
      middle = low + Math.round(share * (high - low));
    }
    probe = Math.min(high - 1, Math.max(low + 1, middle));
    if ((await clock.timeOf(probe)) >= target) {
      high = probe;
    } else {
      low = probe;
    }
    interpolate = !interpolate;
  }
  return high;
}

export interface HourRange {
  /** The hour's start, unix seconds. */
  start: number;
  /** UTC day of the hour. */
  day: string;
  fromBlock: number;
  toBlock: number;
}

/** The UTC midnight of a `YYYY-MM-DD` day, unix seconds. */
export function dayStart(day: string): number {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time)) {
    throw new Error(`not a day: ${day}`);
  }
  return time / 1000;
}

/**
 * Every hour from `launchDay` to the finalized head, as block ranges. An hour
 * with no block is left out; the last one ends at the head.
 */
export async function hourRanges(
  clock: BlockClock,
  launchDay: string,
  head: { number: number; timestamp: number },
): Promise<HourRange[]> {
  const first = dayStart(launchDay);
  if (first > head.timestamp) {
    return [];
  }
  const ranges: HourRange[] = [];
  let blocksPerHour = DEFAULT_BLOCKS_PER_HOUR;
  // A first guess from the head: the launch is this many hours back.
  const hoursBack = (head.timestamp - first) / HOUR_SECS;
  let boundary = await firstBlockAtOrAfter(
    clock,
    first,
    head.number,
    Math.round(head.number - hoursBack * blocksPerHour),
    blocksPerHour,
  );
  for (let start = first; start <= head.timestamp; start += HOUR_SECS) {
    const end = start + HOUR_SECS;
    const next =
      end > head.timestamp
        ? head.number + 1
        : await firstBlockAtOrAfter(
            clock,
            end,
            head.number,
            boundary + Math.round(blocksPerHour * PROBE_MARGIN),
            blocksPerHour,
          );
    if (next > boundary) {
      ranges.push({
        start,
        day: utcDay(start),
        fromBlock: boundary,
        toBlock: Math.min(next - 1, head.number),
      });
      blocksPerHour = Math.max(1, next - boundary);
    }
    boundary = next;
  }
  return ranges;
}
