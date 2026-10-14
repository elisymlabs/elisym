import { describe, expect, it } from 'vitest';
import {
  type BlockClock,
  HOUR_SECS,
  blockClock,
  dayStart,
  firstBlockAtOrAfter,
  hourRanges,
} from '../src/tempo-days';

const LAUNCH = '2026-10-20';
const T0 = dayStart(LAUNCH);
/** Genesis a little over a day before the launch. */
const GENESIS_TIME = T0 - 100_000;

/** Two blocks a second: every timestamp repeats. */
function twoPerSecond(number: number): number {
  return GENESIS_TIME + Math.floor(number / 2);
}

function clockOf(timeOf: (number: number) => number): BlockClock & { reads: number } {
  const clock = {
    reads: 0,
    timeOf: async (number: number) => {
      clock.reads += 1;
      return timeOf(number);
    },
  };
  return clock;
}

/** The first block at or after `target`, by brute force. */
function bruteLowerBound(timeOf: (number: number) => number, target: number, head: number): number {
  for (let number = 0; number <= head; number += 1) {
    if (timeOf(number) >= target) {
      return number;
    }
  }
  return head + 1;
}

describe('firstBlockAtOrAfter', () => {
  it('finds the first of the blocks sharing a timestamp, from any guess', async () => {
    const head = 300_000;
    for (const target of [T0, T0 + 1, T0 + 3599, GENESIS_TIME + 1]) {
      for (const guess of [0, 1000, 200_000, head]) {
        const found = await firstBlockAtOrAfter(clockOf(twoPerSecond), target, head, guess, 64);
        expect(found).toBe(bruteLowerBound(twoPerSecond, target, head));
      }
    }
  });

  it('answers head + 1 past the head and 0 before genesis', async () => {
    expect(await firstBlockAtOrAfter(clockOf(twoPerSecond), T0 + 10 ** 6, 1000, 5, 10)).toBe(1001);
    expect(await firstBlockAtOrAfter(clockOf(twoPerSecond), GENESIS_TIME - 5, 1000, 500, 10)).toBe(
      0,
    );
  });

  it('converges on an uneven clock', async () => {
    const uneven = (number: number) => GENESIS_TIME + Math.floor((number * number) / 50_000);
    const head = 400_000;
    const target = uneven(250_000) + 1;
    expect(await firstBlockAtOrAfter(clockOf(uneven), target, head, 10, 5)).toBe(
      bruteLowerBound(uneven, target, head),
    );
  });
});

describe('hourRanges', () => {
  // Thirty hours after the launch midnight, plus half an hour.
  const headTime = T0 + 30 * HOUR_SECS + 1800;
  const head = { number: (headTime - GENESIS_TIME) * 2 + 1, timestamp: headTime };

  it('splits the run into hours with no gap and no overlap, the last one at the head', async () => {
    const clock = clockOf(twoPerSecond);
    const ranges = await hourRanges(clock, LAUNCH, head);
    expect(ranges).toHaveLength(31);
    for (const [index, range] of ranges.entries()) {
      expect(range.start).toBe(T0 + index * HOUR_SECS);
      expect(range.fromBlock).toBe(bruteLowerBound(twoPerSecond, range.start, head.number));
      const next = ranges[index + 1];
      if (next !== undefined) {
        expect(next.fromBlock).toBe(range.toBlock + 1);
      }
    }
    const last = ranges.at(-1);
    expect(last).toMatchObject({ toBlock: head.number });
    // A day of 24 hours, then the partial second day.
    expect(ranges.filter((range) => range.day === '2026-10-20')).toHaveLength(24);
    expect(ranges.filter((range) => range.day === '2026-10-21')).toHaveLength(7);
    // A few reads per hour, not a full search each.
    expect(clock.reads / ranges.length).toBeLessThan(40);
  });

  it('is empty before the launch', async () => {
    expect(await hourRanges(clockOf(twoPerSecond), '2026-10-25', head)).toEqual([]);
  });

  it('leaves out an hour with no block', async () => {
    // No block between T0 + 1h and T0 + 2h: the chain jumps.
    const gap = (number: number) => {
      const time = twoPerSecond(number);
      return time >= T0 + HOUR_SECS ? time + HOUR_SECS : time;
    };
    const shortHead = { number: (T0 + 3 * HOUR_SECS - GENESIS_TIME) * 2, timestamp: 0 };
    shortHead.timestamp = gap(shortHead.number);
    const ranges = await hourRanges(clockOf(gap), LAUNCH, shortHead);
    expect(ranges.map((range) => range.start)).not.toContain(T0 + HOUR_SECS);
    for (const [index, range] of ranges.entries()) {
      const next = ranges[index + 1];
      if (next !== undefined) {
        expect(next.fromBlock).toBe(range.toBlock + 1);
      }
    }
  });
});

describe('blockClock', () => {
  it('reads a block once, and gives up after three failed reads', async () => {
    let calls = 0;
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        calls += 1;
        const tag = String(args.params?.[0]);
        if (tag === '0x5') {
          return null;
        }
        return { number: tag, timestamp: '0x10', hash: `0x${'cd'.repeat(32)}` };
      },
    };
    const clock = blockClock(client);
    expect(await clock.timeOf(1)).toBe(16);
    expect(await clock.timeOf(1)).toBe(16);
    expect(calls).toBe(1);
    await expect(clock.timeOf(5)).rejects.toThrow('could not be read');
    expect(calls).toBe(4);
  });
});
