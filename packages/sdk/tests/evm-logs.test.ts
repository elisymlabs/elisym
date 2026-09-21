/**
 * Reading Tempo transfers: what decodes, what is dropped, and - the part every
 * verdict rests on - what makes a pass INCOMPLETE rather than empty.
 */
import { describe, expect, it } from 'vitest';
import {
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
  TEMPO_TRANSFER_GUARD,
} from '../src/evm/constants';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  listTempoBlockedLogs,
  listTempoLogs,
  passesHistoryControl,
  readBlockByNumber,
  readFinalizedBlock,
} from '../src/evm/logs';
import type { FakeLog } from './tempo-chain';
import {
  fakeTempoChain,
  invalidRangeError,
  rangeCapError,
  recordedReceipt,
  receiptLogs,
  resultCapError,
  wireLog,
} from './tempo-chain';

const TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const PAYER = '0x0ed8e782415d51eb7192cf0fce9914a5ed23bce1';
const RECIPIENT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const MEMO = `0x${'7e'.repeat(32)}`;

function topicOf(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function amountWord(amount: bigint): string {
  return `0x${amount.toString(16).padStart(64, '0')}`;
}

function memoLog(overrides: Partial<FakeLog> & { amount?: bigint } = {}): FakeLog {
  const { amount, ...rest } = overrides;
  return {
    address: TOKEN,
    topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(PAYER), topicOf(RECIPIENT), MEMO],
    data: amountWord(amount ?? 10_000n),
    blockNumber: 900,
    transactionHash: `0x${'11'.repeat(32)}`,
    logIndex: 2,
    ...rest,
  };
}

describe('decodeTempoTransferLog', () => {
  it('reads a recorded TransferWithMemo whole', () => {
    const logs = receiptLogs(recordedReceipt('mainnet-batch-relayed'));
    const memoLogs = logs.filter((log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC);
    const decoded = decodeTempoTransferLog(wireLog(memoLogs[0]), 'TransferWithMemo', TOKEN);
    expect(decoded.kind).toBe('log');
    if (decoded.kind !== 'log') {
      return;
    }
    expect(decoded.log.from).toBe(PAYER);
    expect(decoded.log.to).toBe(RECIPIENT);
    expect(decoded.log.amount).toBe(10_000n);
    expect(decoded.log.memo).toBe(
      '0xe212c3626c6a7e1d7ea87da9bc16cd19de2f3478e76e47691f95a6fc4aec4634',
    );
    expect(decoded.log.blockNumber).toBe(39_656_736);
  });

  it.each([
    ['another token', { address: `0x${'ee'.repeat(20)}` }],
    [
      'another event on our token',
      { topics: [TRANSFER_TOPIC, topicOf(PAYER), topicOf(RECIPIENT)] },
    ],
  ])('calls a log about %s OTHER, not unreadable', (_label, overrides) => {
    // A receipt is full of these. Inside a FILTERED scan they cannot happen, and
    // the lister treats them as the node answering something it was not asked.
    expect(
      decodeTempoTransferLog(wireLog(memoLog(overrides)), 'TransferWithMemo', TOKEN).kind,
    ).toBe('other');
  });

  it.each([
    [
      'three topics where the event has four',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(PAYER), topicOf(RECIPIENT)] },
    ],
    [
      'five topics',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(PAYER), topicOf(RECIPIENT), MEMO, MEMO] },
    ],
    [
      'dirty upper bytes before the sender',
      {
        topics: [
          TRANSFER_WITH_MEMO_TOPIC,
          `0x${'ff'.repeat(12)}${PAYER.slice(2)}`,
          topicOf(RECIPIENT),
          MEMO,
        ],
      },
    ],
    ['no data at all', { data: '0x' }],
    ['two words of data', { data: `${amountWord(1n)}${'0'.repeat(64)}` }],
    ['data that is not hex', { data: '0xzz' }],
    [
      'a topic that is not a word',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, '0x01', topicOf(RECIPIENT), MEMO] },
    ],
    [
      'a memo topic that is not a whole word',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(PAYER), topicOf(RECIPIENT), '0x01'] },
    ],
    ['a removed log', { removed: true }],
  ])('refuses to read a log with %s', (_label, overrides) => {
    expect(
      decodeTempoTransferLog(wireLog(memoLog(overrides)), 'TransferWithMemo', TOKEN).kind,
    ).toBe('unreadable');
  });

  it.each([
    ['no address', 'address'],
    ['no topics', 'topics'],
    ['no data', 'data'],
    ['no transaction hash', 'transactionHash'],
    ['no log index', 'logIndex'],
    ['no block number', 'blockNumber'],
  ])('refuses an entry with %s', (_label, field) => {
    const entry = wireLog(memoLog());
    delete entry[field];
    expect(decodeTempoTransferLog(entry, 'TransferWithMemo', TOKEN).kind).toBe('unreadable');
  });

  it('reads a plain Transfer, which has three topics and no memo', () => {
    const plain = memoLog({ topics: [TRANSFER_TOPIC, topicOf(PAYER), topicOf(RECIPIENT)] });
    const decoded = decodeTempoTransferLog(wireLog(plain), 'Transfer', TOKEN);
    expect(decoded.kind === 'log' && decoded.log.memo).toBeUndefined();
    expect(decoded.kind === 'log' && decoded.log.amount).toBe(10_000n);
  });
});

describe('decodeTempoBlockedLog', () => {
  const blockedLogs = receiptLogs(recordedReceipt('moderato-blocked-pathusd')).filter(
    (log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC,
  );

  it('reads the recorded guard log, memo and all', () => {
    const decoded = decodeTempoBlockedLog(wireLog(blockedLogs[0]));
    expect(decoded.kind).toBe('log');
    if (decoded.kind !== 'log') {
      return;
    }
    expect(decoded.log.token).toBe('0x20c0000000000000000000000000000000000000');
    expect(decoded.log.receiver).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(decoded.log.amount).toBe(25_000_000n);
    expect(decoded.log.memo).toBe(
      '0x626c6f636b65642073656e646572000000000000000000000000000000000000',
    );
    expect(decoded.log.recipient).toBe(decoded.log.receiver);
  });

  it('calls a log from anywhere but the guard OTHER', () => {
    const elsewhere = { ...blockedLogs[0], address: TOKEN };
    expect(decodeTempoBlockedLog(wireLog(elsewhere)).kind).toBe('other');
  });

  function mutatedWord(index: number, value: string): unknown {
    const data = blockedLogs[0].data;
    const start = 2 + index * 64;
    return wireLog({
      ...blockedLogs[0],
      data: `${data.slice(0, start)}${value}${data.slice(start + 64)}`,
    });
  }

  it.each([
    ['a receipt version this decoder does not know', 1],
    ['an offset that is not 0x60', 2],
    ['a length that is not 320', 3],
    ['a claim version this decoder does not know', 4],
    ['a kind that is not a transfer', 12],
  ])('refuses a guard log with %s', (_label, wordIndex) => {
    expect(decodeTempoBlockedLog(mutatedWord(wordIndex, '9'.padStart(64, '0'))).kind).toBe(
      'unreadable',
    );
  });

  it('refuses a guard log whose body names another token than its own topic', () => {
    // The body and the topics must agree, or a blocked transfer of somebody
    // else's money could answer for ours.
    const otherToken = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`.slice(2).padStart(64, '0');
    expect(decodeTempoBlockedLog(mutatedWord(5, otherToken)).kind).toBe('unreadable');
  });

  it('refuses a guard log whose body names another recipient than its own topic', () => {
    const otherRecipient = `${'0'.repeat(24)}${'cd'.repeat(20)}`;
    expect(decodeTempoBlockedLog(mutatedWord(8, otherRecipient)).kind).toBe('unreadable');
  });

  it.each([
    ['shorter', (data: string) => data.slice(0, -64)],
    ['longer', (data: string) => `${data}${'0'.repeat(64)}`],
  ])('refuses a guard log %s than 448 bytes', (_label, mutate) => {
    const sized = { ...blockedLogs[0], data: mutate(blockedLogs[0].data) };
    expect(decodeTempoBlockedLog(wireLog(sized)).kind).toBe('unreadable');
  });
});

describe('readFinalizedBlock', () => {
  it('reads the number, the timestamp and the hash together', async () => {
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1_700_000_000 } });
    expect(await readFinalizedBlock(chain.client)).toEqual({
      number: 1_000,
      timestamp: 1_700_000_000,
      hash: `0x${'cd'.repeat(32)}`,
    });
  });

  it('answers null when the block is missing a field, never a zero', async () => {
    const chain = fakeTempoChain({ finalized: 1_000 });
    expect(await readFinalizedBlock(chain.client)).toBeNull();
  });
});

describe('listTempoLogs', () => {
  const base = {
    token: TOKEN,
    event: 'TransferWithMemo' as const,
    to: RECIPIENT,
    memo: MEMO,
    minAmount: 10_000n,
    fromBlock: 800,
  };

  it('finds the leg and reports the block it reached', async () => {
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1_700_000_000 },
      logs: [memoLog()],
    });
    const scan = await listTempoLogs(chain.client, base);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
    expect(scan.toBlock).toBe(1_000);
    expect(chain.getLogsCalls[0]).toEqual({
      address: TOKEN,
      topics: [TRANSFER_WITH_MEMO_TOPIC, null, topicOf(RECIPIENT), MEMO],
      fromBlock: 800,
      toBlock: 1_000,
    });
  });

  it('lists every memo log to this recipient when NO memo was asked for', async () => {
    // The memo is optional on the exported scan - reconciliation asks "what
    // came in at all". Re-checking a memo nobody asked for called every entry
    // unreadable and left the pass permanently incomplete.
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [
        memoLog(),
        memoLog({
          logIndex: 1,
          topics: [
            TRANSFER_WITH_MEMO_TOPIC,
            topicOf(PAYER),
            topicOf(RECIPIENT),
            `0x${'99'.repeat(32)}`,
          ],
        }),
      ],
    });
    const scan = await listTempoLogs(chain.client, {
      token: TOKEN,
      event: 'TransferWithMemo',
      to: RECIPIENT,
      minAmount: 10_000n,
      fromBlock: 800,
    });
    expect(scan.complete).toBe(true);
    expect(scan.candidates).toHaveLength(2);
    expect(chain.getLogsCalls[0]?.topics[3]).toBeNull();
  });

  it('filters by the SENDER only when one was asked for', async () => {
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 }, logs: [memoLog()] });
    await listTempoLogs(chain.client, { ...base, from: PAYER });
    expect(chain.getLogsCalls[0]?.topics[1]).toBe(topicOf(PAYER));
  });

  it.each([
    ['below the amount asked for', { amount: 9_999n }],
    [
      'whose sides are equal',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(RECIPIENT), topicOf(RECIPIENT), MEMO] },
    ],
  ])('DROPS a log %s without making the pass incomplete', async (_label, overrides) => {
    // Both are free to forge for the price of gas: a zero-amount
    // `transferFromWithMemo` succeeds from any caller, and an infinite allowance
    // makes a self-transfer free. They prove nothing either way.
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog(overrides)],
    });
    const scan = await listTempoLogs(chain.client, base);
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(true);
  });

  it.each([
    [
      'for another recipient',
      { topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(PAYER), topicOf(PAYER), MEMO] },
    ],
    [
      'with another memo',
      {
        topics: [
          TRANSFER_WITH_MEMO_TOPIC,
          topicOf(PAYER),
          topicOf(RECIPIENT),
          `0x${'99'.repeat(32)}`,
        ],
      },
    ],
  ])('makes the pass INCOMPLETE when the node answers a log %s', async (_label, overrides) => {
    // The filter was explicit. A node that answers something else is not a node
    // whose silence elsewhere means anything - so the answer is re-checked here
    // rather than trusted.
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog()],
    });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs' ? [wireLog(memoLog(overrides))] : chain.client.request(args),
    };
    const scan = await listTempoLogs(client, base);
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(false);
  });

  it('makes the pass INCOMPLETE when the node answers a log from ANOTHER sender', async () => {
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 } });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs'
          ? [
              wireLog(
                memoLog({
                  topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(RECIPIENT), topicOf(RECIPIENT), MEMO],
                }),
              ),
            ]
          : chain.client.request(args),
    };
    const scan = await listTempoLogs(client, { ...base, from: PAYER });
    expect(scan.complete).toBe(false);
  });

  it('makes the pass INCOMPLETE on an entry it cannot read', async () => {
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog({ data: '0x' })],
    });
    const scan = await listTempoLogs(chain.client, base);
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(false);
  });

  it('walks a wide range in chunks of at most 100000 blocks', async () => {
    const chain = fakeTempoChain({ finalized: 250_000, timestamps: { 250_000: 1 } });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 0 });
    expect(chain.getLogsCalls.map((call) => [call.fromBlock, call.toBlock])).toEqual([
      [0, 99_999],
      [100_000, 199_999],
      [200_000, 250_000],
    ]);
    expect(scan.complete).toBe(true);
  });

  it('halves a chunk the node refuses as too many results, and finds the leg', async () => {
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog({ blockNumber: 850 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock > 50 ? resultCapError() : undefined),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 800 });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
  });

  it('halves a cap error thrown by a client that is not this SDK’s', async () => {
    // `@elisym/sdk/evm` is exported for a browser wallet's own provider, which
    // throws its own error shape carrying the node's words. A client whose cap
    // errors go unrecognized never halves: it skips whole chunks and calls
    // every pass incomplete, for ever.
    const walletError = Object.assign(new Error('Internal JSON-RPC error.'), {
      code: -32602,
      data: { message: 'query exceeds max results 20000, retry with the range 1-2' },
    });
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog({ blockNumber: 850 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock > 50 ? walletError : undefined),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 800 });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
  });

  it('halves a cap error whose words are in `message`, the way ethers throws it', async () => {
    const plain = new Error('query exceeds max results 20000, retry with the range 1-2');
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog({ blockNumber: 850 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock > 50 ? plain : undefined),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 800 });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
  });

  it('gives up on a single block the node will not serve, and walks ON', async () => {
    // A chunk that cannot be halved any further is a FAILED chunk, not a
    // question to ask again: without that, one block the node refuses eats the
    // whole request budget and the money further along is never looked for.
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      logs: [memoLog({ blockNumber: 950 })],
      onGetLogs: (call) =>
        call.fromBlock <= 800 && call.toBlock >= 800 ? resultCapError() : undefined,
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 800 });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(false);
  });

  it('halves on a range the node calls too wide as well', async () => {
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      onGetLogs: (call) => (call.toBlock - call.fromBlock > 50 ? rangeCapError() : undefined),
    });
    expect((await listTempoLogs(chain.client, { ...base, fromBlock: 800 })).complete).toBe(true);
  });

  it('does NOT retry an error that means the params are nonsense', async () => {
    // Four Tempo failures share `-32602` and differ only by message. Halving on
    // "invalid block range params" would be an infinite loop.
    const chain = fakeTempoChain({
      finalized: 1_000,
      timestamps: { 1_000: 1 },
      onGetLogs: () => invalidRangeError(),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 800 });
    expect(scan.complete).toBe(false);
    expect(chain.getLogsCalls).toHaveLength(1);
  });

  it('keeps walking after a failed chunk, and still reports the pass incomplete', async () => {
    const chain = fakeTempoChain({
      finalized: 250_000,
      timestamps: { 250_000: 1 },
      logs: [memoLog({ blockNumber: 240_000 })],
      onGetLogs: (_call, index) => (index === 0 ? new Error('the node fell over') : undefined),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 0 });
    // The money was in a later chunk, and it is still the customer's money.
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(false);
  });

  it('treats an answer that is not a list as a failed chunk', async () => {
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 } });
    const client = {
      request: async (args: { method: string }) =>
        args.method === 'eth_getLogs' ? 'nope' : chain.client.request(args),
    };
    const scan = await listTempoLogs(client, base);
    expect(scan.complete).toBe(false);
  });

  it.each([
    ['is not an integer', 1.5],
    ['is negative', -1],
    ['is above the head', 1_001],
    ['is not a safe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses to scan when the floor %s, and never substitutes one', async (_label, fromBlock) => {
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 }, logs: [memoLog()] });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock });
    expect(scan.complete).toBe(false);
    expect(scan.candidates).toEqual([]);
    expect(chain.getLogsCalls).toEqual([]);
  });

  it('is incomplete, not empty, when the finalized block cannot be read', async () => {
    const chain = fakeTempoChain({ finalized: null });
    const scan = await listTempoLogs(chain.client, base);
    expect(scan).toEqual({ candidates: [], complete: false, toBlock: null });
  });

  it('stops after its request ceiling rather than walking for ever', async () => {
    // A node that answers the result cap for every chunk would otherwise be
    // asked once per block. Incomplete, so nothing concludes from it.
    const chain = fakeTempoChain({
      finalized: 5_000_000,
      timestamps: { 5_000_000: 1 },
      onGetLogs: () => resultCapError(),
    });
    const scan = await listTempoLogs(chain.client, { ...base, fromBlock: 0 });
    expect(scan.complete).toBe(false);
    expect(chain.getLogsCalls.length).toBeLessThanOrEqual(512);
  });

  it.each([
    ['below its floor', 1],
    ['above the head it reached', 1_001],
  ])('makes the pass INCOMPLETE on a log from %s', async (_label, blockNumber) => {
    // The block range is a filter dimension like any other, and BOTH ends of
    // it are the node answering something else when they are crossed.
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 } });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs'
          ? [wireLog(memoLog({ blockNumber }))]
          : chain.client.request(args),
    };
    const scan = await listTempoLogs(client, base);
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(false);
  });

  it('finds the leg when the address was asked for in another CASE', async () => {
    // Addresses arrive checksummed from wallets and explorers. The topic is
    // built lowercase and every comparison is case-insensitive, or the same
    // address in another case finds nothing and a paid job reads as unpaid.
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 }, logs: [memoLog()] });
    const scan = await listTempoLogs(chain.client, {
      ...base,
      to: `0x${RECIPIENT.slice(2).toUpperCase()}`,
    });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
  });

  it('reads a memo-less leg by sender and recipient, with no memo to match', async () => {
    // A withdrawal has no memo at all; re-checking one would make every entry
    // unreadable and the pass permanently incomplete.
    const plain = memoLog({ topics: [TRANSFER_TOPIC, topicOf(PAYER), topicOf(RECIPIENT)] });
    const chain = fakeTempoChain({ finalized: 1_000, timestamps: { 1_000: 1 }, logs: [plain] });
    const scan = await listTempoLogs(chain.client, {
      ...base,
      event: 'Transfer',
      from: PAYER,
      memo: undefined,
    });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
  });

  it('stops on an aborted signal without calling itself complete', async () => {
    const chain = fakeTempoChain({ finalized: 250_000, timestamps: { 250_000: 1 } });
    const scan = await listTempoLogs(chain.client, {
      ...base,
      fromBlock: 0,
      signal: AbortSignal.abort(),
    });
    expect(scan.complete).toBe(false);
    expect(chain.getLogsCalls).toEqual([]);
  });
});

describe('listTempoBlockedLogs', () => {
  const blocked = receiptLogs(recordedReceipt('moderato-blocked-pathusd')).filter(
    (log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC,
  );
  const PATHUSD = '0x20c0000000000000000000000000000000000000';
  const BLOCKED_RECEIVER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  it('finds the guard log for one token and one receiver', async () => {
    const chain = fakeTempoChain({
      finalized: 35_790_000,
      timestamps: { 35_790_000: 1 },
      logs: blocked,
    });
    const scan = await listTempoBlockedLogs(chain.client, {
      token: PATHUSD,
      receiver: BLOCKED_RECEIVER,
      fromBlock: 35_780_000,
    });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.complete).toBe(true);
    expect(chain.getLogsCalls[0]?.address).toBe(TEMPO_TRANSFER_GUARD);
    expect(chain.getLogsCalls[0]?.topics).toEqual([
      TRANSFER_BLOCKED_TOPIC,
      topicOf(PATHUSD),
      topicOf(BLOCKED_RECEIVER),
    ]);
  });

  it('calls a guard log from OUTSIDE the range it asked for unreadable', async () => {
    // The blocked scan's empty-and-complete answer is what lets a caller say
    // money was never parked with the guard, so its range is a filter like
    // any other - the transfer scan has bounded both ends since round 4.
    const chain = fakeTempoChain({ finalized: 35_790_000, timestamps: { 35_790_000: 1 } });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs'
          ? blocked.map((log) => wireLog({ ...log, blockNumber: 35_795_000 }))
          : chain.client.request(args),
    };
    const scan = await listTempoBlockedLogs(client, {
      token: PATHUSD,
      receiver: BLOCKED_RECEIVER,
      fromBlock: 35_780_000,
    });
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(false);
  });

  it('calls a guard log for another TOKEN unreadable, not merely uninteresting', async () => {
    // A filtered scan is answered only with what it asked for, so an entry for
    // another token is the node answering something else: incomplete, never
    // empty. An empty-and-complete pass here is what lets a caller conclude
    // the money was not parked with the guard.
    const chain = fakeTempoChain({ finalized: 35_790_000, timestamps: { 35_790_000: 1 } });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs' ? blocked.map(wireLog) : chain.client.request(args),
    };
    const scan = await listTempoBlockedLogs(client, {
      token: TOKEN,
      receiver: BLOCKED_RECEIVER,
      fromBlock: 35_780_000,
    });
    expect(scan.candidates).toEqual([]);
    expect(scan.complete).toBe(false);
  });

  it('is incomplete when a chunk fails, never empty', async () => {
    const chain = fakeTempoChain({
      finalized: 35_790_000,
      timestamps: { 35_790_000: 1 },
      logs: blocked,
      onGetLogs: () => new Error('the node fell over'),
    });
    const scan = await listTempoBlockedLogs(chain.client, {
      token: PATHUSD,
      receiver: BLOCKED_RECEIVER,
      fromBlock: 35_780_000,
    });
    expect(scan.complete).toBe(false);
  });
});

describe('readBlockByNumber', () => {
  it('refuses a block that is not the one it asked for', async () => {
    // The deadline that makes an absence final is read off this timestamp, so
    // a backend answering another block would date the scan by another clock.
    const client = {
      request: async () => ({ number: '0x2', timestamp: '0x5', hash: `0x${'ab'.repeat(32)}` }),
    };
    expect(await readBlockByNumber(client, 1)).toBeNull();
    expect(await readBlockByNumber(client, 2)).toEqual({
      number: 2,
      timestamp: 5,
      hash: `0x${'ab'.repeat(32)}`,
    });
  });
});

describe('passesHistoryControl', () => {
  it('passes on a window that comes back non-empty', async () => {
    const chain = fakeTempoChain({ logs: [memoLog({ blockNumber: 995 })] });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 1_000 })).toBe(true);
    expect(chain.getLogsCalls[0]).toMatchObject({ fromBlock: 745, toBlock: 1_000 });
    // Unfiltered on purpose: it asks whether this endpoint serves this token's
    // history at all, not whether our payment is in it.
    expect(chain.getLogsCalls[0]?.topics).toEqual([]);
  });

  it('widens the window while it comes back empty', async () => {
    const chain = fakeTempoChain({ logs: [memoLog({ blockNumber: 100 })] });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 5_000 })).toBe(true);
    expect(chain.getLogsCalls.length).toBeGreaterThan(1);
  });

  it('FAILS when the window walks back to genesis and is still empty', async () => {
    const chain = fakeTempoChain({ logs: [] });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 500 })).toBe(false);
  });

  it('fails when the window comes back as something that is not a list', async () => {
    const chain = fakeTempoChain({ logs: [memoLog({ blockNumber: 995 })] });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getLogs' ? 'plenty' : chain.client.request(args),
    };
    expect(await passesHistoryControl(client, { token: TOKEN, edgeBlock: 1_000 })).toBe(false);
  });

  it('fails on an error: a node that will not answer has vouched for nothing', async () => {
    const chain = fakeTempoChain({ onGetLogs: () => new Error('the node fell over') });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 1_000 })).toBe(
      false,
    );
  });

  it('shrinks the window when the node says there are too many results', async () => {
    const chain = fakeTempoChain({
      logs: [memoLog({ blockNumber: 1_000 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock > 60 ? resultCapError() : undefined),
    });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 1_000 })).toBe(true);
  });

  it('passes when even a single block holds more logs than the node will return', async () => {
    // The node is telling us this token's history is here - loudly.
    const chain = fakeTempoChain({ onGetLogs: () => resultCapError() });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 1_000 })).toBe(true);
  });

  it('slides the window back rather than re-asking a width the node refuses', async () => {
    // Past the node's range cap, widening only re-asks a question it has
    // already answered: refuse, halve, empty, widen, refuse. A token quieter
    // than one log per cap-width at an edge would never be vouched for, and
    // "nobody paid" would be unreachable for ever.
    const chain = fakeTempoChain({
      logs: [memoLog({ blockNumber: 800_000 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock >= 65_536 ? rangeCapError() : undefined),
    });
    expect(await passesHistoryControl(chain.client, { token: TOKEN, edgeBlock: 1_000_000 })).toBe(
      true,
    );
  });

  it('leaves the caller’s options untouched while the window walks', async () => {
    const options = { token: TOKEN, edgeBlock: 1_000_000 };
    const chain = fakeTempoChain({
      logs: [memoLog({ blockNumber: 800_000 })],
      onGetLogs: (call) => (call.toBlock - call.fromBlock >= 65_536 ? rangeCapError() : undefined),
    });
    await passesHistoryControl(chain.client, options);
    expect(options.edgeBlock).toBe(1_000_000);
  });

  it('fails on an aborted signal', async () => {
    const chain = fakeTempoChain({ logs: [memoLog({ blockNumber: 995 })] });
    expect(
      await passesHistoryControl(chain.client, {
        token: TOKEN,
        edgeBlock: 1_000,
        signal: AbortSignal.abort(),
      }),
    ).toBe(false);
  });
});
