import { describe, expect, it } from 'vitest';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import { type FakeLog, fakeTempoChain, invalidRangeError } from '../../pay-core/tests/tempo-chain';
import { HOUR_RETRIES, scanTempo, tempoCandidates } from '../src/tempo';
import type { HourRange } from '../src/tempo-days';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const STRANGER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
const MARKED = `0xfab22e7e${'01'.repeat(28)}`;
const LEGACY = `0x${'01'.repeat(32)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const DAY = '2026-10-20';

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

function leg(
  to: string,
  amount: bigint,
  { memo = MARKED, logIndex = 0, block = 150, token = USDCE, hash = HASH } = {},
): FakeLog {
  return {
    address: token,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(to)}`, memo],
    data: `0x${word(amount)}`,
    blockNumber: block,
    transactionHash: hash,
    logIndex,
  };
}

const RANGES: HourRange[] = [
  { start: 0, day: DAY, fromBlock: 100, toBlock: 199, partial: false },
  { start: 3600, day: DAY, fromBlock: 200, toBlock: 299, partial: false },
];

describe('scanTempo', () => {
  it('scans every registry token hour by hour and groups each payment', async () => {
    const chain = fakeTempoChain({
      logs: [
        leg(PAYOUT, 48_510_000n),
        leg(TREASURY, 490_000n, { logIndex: 1 }),
        leg(STRANGER, 5n, { logIndex: 2 }),
        leg(PAYOUT, 3n, { memo: LEGACY, logIndex: 3 }),
        leg(PAYOUT, 7n, { token: PATHUSD, block: 250, hash: `0x${'ac'.repeat(32)}` }),
      ],
    });
    const scan = await scanTempo(chain.client, 'mainnet', RANGES, new Set([TREASURY]));
    expect(chain.getLogsCalls.map((call) => [call.address, call.fromBlock, call.toBlock])).toEqual([
      [USDCE, 100, 199],
      [USDCE, 200, 299],
      [PATHUSD, 100, 199],
      [PATHUSD, 200, 299],
    ]);
    expect(scan.candidates).toEqual([
      {
        rail: 'tempo',
        network: 'mainnet',
        reference: MARKED,
        day: DAY,
        position: { primary: 150, secondary: 0 },
        coin: 'USDC.e',
        payout: PAYOUT,
        provider: 48_510_000n,
        fees: [{ treasury: TREASURY, amount: 490_000n }],
      },
      expect.objectContaining({ coin: 'pathUSD', provider: 7n, reference: MARKED }),
    ]);
    expect(scan.incompleteDays.size).toBe(0);
  });

  it('retries an incomplete hour, and flags its day only when the retries run out', async () => {
    let failures = HOUR_RETRIES;
    const recovering = fakeTempoChain({
      logs: [leg(PAYOUT, 1n, { token: PATHUSD })],
      onGetLogs: () => {
        if (failures > 0) {
          failures -= 1;
          return invalidRangeError();
        }
        return undefined;
      },
    });
    const first = RANGES.slice(0, 1);
    const recovered = await scanTempo(recovering.client, 'devnet', first, new Set());
    expect(recovered.incompleteDays.size).toBe(0);
    expect(recovered.candidates).toHaveLength(1);
    // Devnet has pathUSD only: one hour, three failures, then the answer.
    expect(recovering.getLogsCalls).toHaveLength(HOUR_RETRIES + 1);

    const down = fakeTempoChain({ onGetLogs: () => invalidRangeError() });
    const failed = await scanTempo(down.client, 'devnet', first, new Set());
    expect(down.getLogsCalls).toHaveLength(HOUR_RETRIES + 1);
    expect([...failed.incompleteDays]).toEqual([DAY]);
    expect(failed.context).toEqual([
      { day: DAY, rail: 'tempo', bucket: 'incomplete_hours', count: 1 },
    ]);
  });
});

describe('tempoCandidates', () => {
  function decoded(log: FakeLog) {
    return {
      token: log.address,
      blockHash: `0x${'cd'.repeat(32)}`,
      from: PAYER,
      to: `0x${(log.topics[2] ?? '').slice(26)}`,
      amount: BigInt(log.data),
      memo: log.topics[3],
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
    };
  }

  it('puts a payment with only treasury legs in treasury_only, never a purchase', () => {
    const found = tempoCandidates(
      [decoded(leg(TREASURY, 490_000n))],
      'mainnet',
      DAY,
      new Set([TREASURY]),
    );
    expect(found.candidates).toEqual([]);
    expect(found.context).toEqual([{ day: DAY, rail: 'tempo', bucket: 'treasury_only', count: 1 }]);
  });

  it('takes the largest non-treasury leg as the provider, the rest of them as extra', () => {
    const found = tempoCandidates(
      [decoded(leg(STRANGER, 5n)), decoded(leg(PAYOUT, 9n, { logIndex: 4 }))],
      'mainnet',
      DAY,
      new Set(),
    );
    expect(found.candidates).toEqual([
      expect.objectContaining({ payout: PAYOUT, provider: 9n, fees: [] }),
    ]);
  });

  it('keeps two memos of one transaction apart, and ignores an unmarked memo', () => {
    const other = `0xfab22e7e${'02'.repeat(28)}`;
    const found = tempoCandidates(
      [
        decoded(leg(PAYOUT, 9n)),
        decoded(leg(PAYOUT, 8n, { memo: other, logIndex: 1 })),
        decoded(leg(PAYOUT, 7n, { memo: LEGACY, logIndex: 2 })),
      ],
      'mainnet',
      DAY,
      new Set(),
    );
    expect(found.candidates.map((candidate) => candidate.reference)).toEqual([MARKED, other]);
  });
});
