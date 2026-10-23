/**
 * The start check of an `eip3009` chain's RPC: the real query shapes, data
 * required (not merely no error), a search bounded to one range cap after the
 * 3-day-old floor, range halving, and a wrong answer told from a transport one.
 */
import { EvmRpcError } from '@elisym/pay-core/evm';
import { describe, expect, it } from 'vitest';
import { CATCH_UP_SECS, ORDER_SCAN_MARGIN_SECS } from '../src/constants';
import { startCheckEip3009, startEip3009Chains, sweepEip3009 } from '../src/eip3009';
import {
  type FakeLog,
  blockHashOf,
  hexNumber,
  plainTransfer,
  txHashOf,
  word,
} from './eip3009-chain';
import { NOW, OTHER_PAYOUT, PAYER, PRICE, type Run, blockAt, setup } from './eip3009-support';

function floorOf(run: Run): number {
  return blockAt(run, NOW - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS);
}

/** A run whose chain has one old USDC transfer, `offset` blocks after the 3-day floor. */
function withOldTransfer(options: Parameters<typeof setup>[0] = {}, offset = 600) {
  const run = setup(options);
  const hash = txHashOf(900);
  plainTransfer(run.fake, {
    hash,
    from: PAYER,
    to: OTHER_PAYOUT,
    value: PRICE,
    block: floorOf(run) + offset,
  });
  return { run, hash };
}

/** The unfiltered `Transfer` searches (step 1): `[from, to]` of each. */
function searches(run: Run): [number, number][] {
  return run.fake.calls.flatMap(({ method, params }) => {
    const filter = params[0] as { topics?: unknown[]; fromBlock?: string; toBlock?: string };
    return method === 'eth_getLogs' && filter.topics?.length === 1
      ? [[Number.parseInt(filter.fromBlock ?? '', 16), Number.parseInt(filter.toBlock ?? '', 16)]]
      : [];
  });
}

function failing(run: Run, method: string, error: () => unknown): void {
  run.fake.script = (called) => {
    if (called === method) {
      throw error();
    }
    return undefined;
  };
}

describe('startCheckEip3009', () => {
  it('passes an RPC that serves an old transfer, its recipient query and its receipt', async () => {
    const { run, hash } = withOldTransfer();
    expect(await startCheckEip3009(run.context, NOW)).toEqual({ kind: 'passed' });
    // The recipient query (the scan's shape) and the old receipt were asked.
    const recipientQueries = run.fake.calls.filter(
      ({ method, params }) =>
        method === 'eth_getLogs' && (params[0] as { topics: unknown[] }).topics.length === 3,
    );
    expect(recipientQueries.length).toBeGreaterThan(0);
    expect(run.fake.calls.some(({ params }) => params[0] === hash)).toBe(true);
  });

  it('searches from the floor, doubling, and never past one range cap after it', async () => {
    // Mainnet: the only transfer sits one block past the span.
    const { run } = withOldTransfer({ caip2: 'eip155:8453' }, 1000);
    const outcome = await startCheckEip3009(run.context, NOW);
    expect(outcome).toEqual({
      kind: 'wrong',
      problem: `no USDC transfer in the 1000 blocks from block ${floorOf(run)} (three days back): the RPC does not serve three days of logs`,
    });
    const asked = searches(run);
    expect(asked[0]).toEqual([floorOf(run), floorOf(run)]);
    expect(asked[1]).toEqual([floorOf(run) + 1, floorOf(run) + 2]);
    expect(Math.max(...asked.map(([, to]) => to))).toBe(floorOf(run) + 999);
  });

  it('passes with the only old transfer at the last block of the span, found again there', async () => {
    const { run } = withOldTransfer({ caip2: 'eip155:8453' }, 999);
    expect(await startCheckEip3009(run.context, NOW)).toEqual({ kind: 'passed' });
  });

  it('takes a thin testnet with no old transfer, with a warning', async () => {
    const run = setup();
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'passed',
      warning: `no USDC transfer in the 1000 blocks from block ${floorOf(run)} (three days back): a thin testnet, the RPC is taken unchecked`,
    });
  });

  it('halves on a range error and still requires the found log back', async () => {
    const { run } = withOldTransfer({ providerCap: 4 });
    expect(await startCheckEip3009(run.context, NOW)).toEqual({ kind: 'passed' });
    const widths = run.fake.calls.flatMap(({ method, params }) => {
      const filter = params[0] as { fromBlock?: string; toBlock?: string };
      return method === 'eth_getLogs'
        ? [
            Number.parseInt(filter.toBlock ?? '', 16) -
              Number.parseInt(filter.fromBlock ?? '', 16) +
              1,
          ]
        : [];
    });
    // Asked too wide, told so, and asked again within the provider's cap.
    expect(widths.some((width) => width > 4)).toBe(true);
    expect(widths.at(-1)).toBeLessThanOrEqual(4);
  });

  it('is a wrong answer when the recipient query leaves out the log it found', async () => {
    const { run, hash } = withOldTransfer();
    run.fake.script = (method, params) =>
      method === 'eth_getLogs' && (params[0] as { topics: unknown[] }).topics.length === 3
        ? { value: [] }
        : undefined;
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'wrong',
      problem: `asked for the transfers to ${OTHER_PAYOUT}, the RPC left out the one of ${hash} it had found`,
    });
  });

  it('is a wrong answer when the recipient query answers other logs but not the found one', async () => {
    const { run, hash } = withOldTransfer();
    const other = txHashOf(901);
    plainTransfer(run.fake, {
      hash: other,
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: floorOf(run) + 700,
    });
    const recipientQuery = (params: readonly unknown[]) =>
      (params[0] as { topics: unknown[] }).topics.length === 3;
    run.fake.script = (method, params) =>
      method === 'eth_getLogs' && recipientQuery(params)
        ? { value: run.fake.logs.filter((log) => log.transactionHash === other) }
        : undefined;
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'wrong',
      problem: `asked for the transfers to ${OTHER_PAYOUT}, the RPC left out the one of ${hash} it had found`,
    });
  });

  it.each([
    ['a null receipt', () => ({ value: null }), 'wrong'],
    [
      'a refused receipt',
      () => {
        throw new EvmRpcError('eth_getTransactionReceipt', {
          code: -32000,
          message: 'Archive requests require a personal token',
        });
      },
      'wrong',
    ],
    [
      'an HTTP 429',
      () => {
        throw new Error('rpc eth_getTransactionReceipt answered HTTP 429');
      },
      'transient',
    ],
    [
      'a -32011 rate limit',
      () => {
        throw new EvmRpcError('eth_getTransactionReceipt', {
          code: -32011,
          message: 'request limit reached',
        });
      },
      'transient',
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      'transient',
    ],
  ] as const)('reads %s as %s', async (_label, answer, kind) => {
    const { run, hash } = withOldTransfer();
    run.fake.script = (method) => (method === 'eth_getTransactionReceipt' ? answer() : undefined);
    const outcome = await startCheckEip3009(run.context, NOW);
    expect(outcome.kind).toBe(kind);
    expect(outcome.kind === 'passed' ? '' : outcome.problem).toContain(
      `the receipt of ${hash} (three days old) could not be read`,
    );
  });

  it('is a wrong answer for refused old logs, transient for a log read that times out', async () => {
    const refused = withOldTransfer().run;
    failing(
      refused,
      'eth_getLogs',
      () => new EvmRpcError('eth_getLogs', { code: -32000, message: 'History has been pruned' }),
    );
    expect((await startCheckEip3009(refused.context, NOW)).kind).toBe('wrong');
    const slow = withOldTransfer().run;
    failing(slow, 'eth_getLogs', () => new Error('fetch failed'));
    expect((await startCheckEip3009(slow.context, NOW)).kind).toBe('transient');
  });

  it('is a wrong answer for another chain id, transient when it cannot be read', async () => {
    const other = withOldTransfer().run;
    other.fake.chainId = 1;
    expect(await startCheckEip3009(other.context, NOW)).toEqual({
      kind: 'wrong',
      problem: 'eth_chainId names another chain than Base Sepolia',
    });
    const down = withOldTransfer().run;
    failing(down, 'eth_chainId', () => new Error('rpc eth_chainId answered HTTP 503'));
    expect((await startCheckEip3009(down.context, NOW)).kind).toBe('transient');
  });

  it('is a wrong answer for 3-day-old blocks the RPC does not hold', async () => {
    const { run } = withOldTransfer();
    run.fake.script = (method, params) =>
      method === 'eth_getBlockByNumber' && params[0] !== 'finalized' ? { value: null } : undefined;
    expect((await startCheckEip3009(run.context, NOW)).kind).toBe('wrong');
  });
});

describe('the start check: the re-query must return the very log it found', () => {
  const other = `0x${word('0x1111111111111111111111111111111111111111')}`;
  it.each([
    ['transaction', (log: FakeLog): FakeLog => ({ ...log, transactionHash: txHashOf(902) })],
    [
      'log index',
      (log: FakeLog): FakeLog => ({
        ...log,
        logIndex: hexNumber(Number.parseInt(log.logIndex, 16) + 1),
      }),
    ],
    [
      'block hash',
      (log: FakeLog): FakeLog => ({
        ...log,
        blockHash: blockHashOf(Number.parseInt(log.blockNumber, 16), 1),
      }),
    ],
    [
      'block number',
      (log: FakeLog): FakeLog => ({
        ...log,
        blockNumber: hexNumber(Number.parseInt(log.blockNumber, 16) + 1),
      }),
    ],
    [
      'sender',
      (log: FakeLog): FakeLog => ({
        ...log,
        topics: [log.topics[0] ?? '', other, log.topics[2] ?? ''],
      }),
    ],
    ['value', (log: FakeLog): FakeLog => ({ ...log, data: `0x${word(PRICE + 1n)}` })],
    [
      'contract',
      (log: FakeLog): FakeLog => ({
        ...log,
        address: '0x1111111111111111111111111111111111111111',
      }),
    ],
    [
      'recipient',
      (log: FakeLog): FakeLog => ({
        ...log,
        topics: [log.topics[0] ?? '', log.topics[1] ?? '', other],
      }),
    ],
  ] as const)('is a wrong answer when only its %s differs', async (_label, change) => {
    const { run } = withOldTransfer();
    run.fake.script = (method, params) =>
      method === 'eth_getLogs' && (params[0] as { topics: unknown[] }).topics.length === 3
        ? { value: run.fake.logs.map(change) }
        : undefined;
    expect((await startCheckEip3009(run.context, NOW)).kind).toBe('wrong');
  });
});

describe('the start check: what a failed request says', () => {
  it.each([400, 401, 403, 404, 410])(
    'reads HTTP %i (a mistyped URL, a rejected key) as a wrong answer that stops start-up',
    async (status) => {
      const { run } = withOldTransfer();
      failing(run, 'eth_chainId', () => new Error(`rpc eth_chainId answered HTTP ${status}`));
      expect(await startCheckEip3009(run.context, NOW)).toEqual({
        kind: 'wrong',
        problem: `eth_chainId could not be read: the RPC refused eth_chainId (HTTP ${status})`,
      });
      await expect(startEip3009Chains([run.context], NOW, () => undefined)).rejects.toThrow(
        `HTTP ${status}`,
      );
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    'reads HTTP %i as transient: the node starts with the chain off',
    async (status) => {
      const { run } = withOldTransfer();
      failing(
        run,
        'eth_getTransactionReceipt',
        () => new Error(`rpc eth_getTransactionReceipt answered HTTP ${status}`),
      );
      expect((await startCheckEip3009(run.context, NOW)).kind).toBe('transient');
      await startEip3009Chains([run.context], NOW, () => undefined);
      expect(run.context.gate.kind).toBe('deferred');
    },
  );

  it.each([
    ['a network error', () => new TypeError('fetch failed'), 'transient'],
    ['a body that is not JSON', () => new SyntaxError('Unexpected token <'), 'wrong'],
    [
      'a body that is no JSON-RPC answer',
      () => new Error('rpc eth_getLogs answered something that is not a JSON-RPC response'),
      'wrong',
    ],
    [
      'an answer to another request',
      () => new Error('rpc eth_getLogs answered the wrong request id'),
      'wrong',
    ],
    [
      'a JSON-RPC internal error (-32603)',
      () => new EvmRpcError('eth_getLogs', { code: -32603, message: 'internal error' }),
      'transient',
    ],
    [
      'a provider error object at a rate limit',
      () => ({ code: -32005, message: 'limit' }),
      'transient',
    ],
    ['a provider error object refusing', () => ({ code: -32000, message: 'pruned' }), 'wrong'],
  ] as const)('reads %s as %s', async (_label, error, kind) => {
    const { run } = withOldTransfer();
    failing(run, 'eth_getLogs', error);
    expect((await startCheckEip3009(run.context, NOW)).kind).toBe(kind);
  });
});

describe('startEip3009Chains', () => {
  it('refuses start-up on mainnet when the RPC answers [] near the floor', async () => {
    const run = setup({ caip2: 'eip155:8453' });
    await expect(startEip3009Chains([run.context], NOW, () => undefined)).rejects.toThrow(
      `Base RPC failed the start check: no USDC transfer in the 1000 blocks from block ${floorOf(run)} (three days back): the RPC does not serve three days of logs`,
    );
  });

  it('starts with a chain whose check met a transport failure, off until a later check', async () => {
    const run = setup({ caip2: 'eip155:8453' });
    run.fake.script = () => {
      throw new Error('rpc eth_chainId answered HTTP 429');
    };
    const logs: string[] = [];
    await startEip3009Chains([run.context], NOW, (message) => logs.push(message));
    expect(run.context.gate).toEqual({
      kind: 'deferred',
      attempts: 1,
      nextAt: NOW + 60,
      problem: 'eth_chainId could not be read: eth_chainId failed (HTTP 429)',
    });
    expect(logs).toEqual([
      'WARNING: Base RPC not yet verified (eth_chainId could not be read: eth_chainId failed (HTTP 429)); payments there are not being scanned',
    ]);
  });

  it('verifies a chain that passes, and logs a thin testnet', async () => {
    const run = setup();
    const logs: string[] = [];
    await startEip3009Chains([run.context], NOW, (message) => logs.push(message));
    expect(run.context.gate).toEqual({ kind: 'verified' });
    expect(logs).toEqual([expect.stringMatching(/^warning: Base Sepolia: no USDC transfer/)]);
  });
});

describe('the deferred start check backs off', () => {
  it('waits 60, 120, 300, 600, then 900 seconds and no longer, and is verified once it passes', async () => {
    const run = setup();
    const transient = async () => ({ kind: 'transient' as const, problem: 'HTTP 503' });
    await startEip3009Chains([run.context], NOW, () => undefined, transient);
    const waits: number[] = [];
    let at = NOW;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const gate = run.context.gate;
      if (gate.kind !== 'deferred') {
        throw new Error('not deferred');
      }
      waits.push(gate.nextAt - at);
      at = gate.nextAt;
      await sweepEip3009(run.state, run.context, at, () => undefined, { check: transient });
    }
    expect(waits).toEqual([60, 120, 300, 600, 900, 900]);
    await sweepEip3009(run.state, run.context, at + 900, () => undefined, {
      check: async () => ({ kind: 'passed' }),
      catchUp: async () => ({ paid: [], incomplete: [] }),
    });
    expect(run.context.gate).toEqual({ kind: 'verified' });
  });
});

describe('the start check: a raised log range cap', () => {
  it('still searches only the registry span after the 3-day floor: a recent transfer never passes on mainnet', async () => {
    const run = setup({ caip2: 'eip155:8453', providerCap: 200_000 });
    // Raised by the operator (allowed: at least the registry's 1000).
    run.context.rangeCap = 120_000;
    // The only transfer is 100 000 blocks (about 2.3 days) after the floor: 17 hours old.
    plainTransfer(run.fake, {
      hash: txHashOf(905),
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: floorOf(run) + 100_000,
    });
    expect(await startCheckEip3009(run.context, NOW)).toEqual({
      kind: 'wrong',
      problem: `no USDC transfer in the 1000 blocks from block ${floorOf(run)} (three days back): the RPC does not serve three days of logs`,
    });
  });

  it('re-queries the found log at the raised cap, the shape the scan then uses', async () => {
    const { run } = withOldTransfer({ caip2: 'eip155:8453', providerCap: 200_000 });
    run.context.rangeCap = 120_000;
    expect(await startCheckEip3009(run.context, NOW)).toEqual({ kind: 'passed' });
    const recipientQueries = run.fake.calls.flatMap(({ method, params }) => {
      const filter = params[0] as { topics?: unknown[]; fromBlock?: string; toBlock?: string };
      return method === 'eth_getLogs' && filter.topics?.length === 3
        ? [
            Number.parseInt(filter.toBlock ?? '', 16) -
              Number.parseInt(filter.fromBlock ?? '', 16) +
              1,
          ]
        : [];
    });
    expect(recipientQueries).toEqual([120_000]);
  });
});

describe('the start check: every element counts', () => {
  it('finds the found log anywhere in the re-query answer, not only first', async () => {
    const run = setup({ caip2: 'eip155:8453' });
    const floor = floorOf(run);
    // Recorded first, but later in the chain: the re-query lists it before the found one.
    plainTransfer(run.fake, {
      hash: txHashOf(903),
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: floor + 900,
    });
    plainTransfer(run.fake, {
      hash: txHashOf(904),
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: floor + 100,
    });
    expect(await startCheckEip3009(run.context, NOW)).toEqual({ kind: 'passed' });
  });

  it('checks every chain at start: a wrong answer on the second stops start-up', async () => {
    const first = setup();
    const second = setup({ caip2: 'eip155:8453' });
    await expect(
      startEip3009Chains([first.context, second.context], NOW, () => undefined),
    ).rejects.toThrow(/^Base RPC failed the start check/);
    expect(first.context.gate).toEqual({ kind: 'verified' });
  });
});
