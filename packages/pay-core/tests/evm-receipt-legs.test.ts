/**
 * The receipt pre-read a merchant runs before verifying a reported hash: what
 * it may answer, and that it never answers more than "unreadable" without the
 * chain bound and named.
 */
import { describe, expect, it } from 'vitest';
import { TRANSFER_BLOCKED_TOPIC } from '../src/evm/constants';
import { readTempoReceiptLegs } from '../src/evm/receipt-legs';
import { chainByCaip2 } from '../src/payment/chains';
import type { FakeChainOptions } from './tempo-chain';
import { fakeTempoChain, recordedReceipt } from './tempo-chain';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const RECIPIENT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const BLOCKED_RECEIVER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SINGLE = recordedReceipt('mainnet-single-in-7702');
const SINGLE_HASH = String(SINGLE.transactionHash);
const SINGLE_BLOCK = Number(BigInt(String(SINGLE.blockNumber)));
const SINGLE_MEMO = '0x77736adb5138f60729b744b0e050858c88891a2f9f9317ec623956e99103bb04';
const BLOCKED = recordedReceipt('moderato-blocked-pathusd');
const BLOCKED_HASH = String(BLOCKED.transactionHash);
const BLOCKED_BLOCK = Number(BigInt(String(BLOCKED.blockNumber)));
const BLOCKED_MEMO = '0x626c6f636b65642073656e646572000000000000000000000000000000000000';

function chainOf(caip2: string) {
  const chain = chainByCaip2(caip2);
  if (chain === undefined) {
    throw new Error(caip2);
  }
  return chain;
}

const MAINNET = chainOf('eip155:4217');
const MODERATO = chainOf('eip155:42431');

function mainnet(options: FakeChainOptions = {}) {
  return fakeTempoChain({
    finalized: 40_000_000,
    timestamps: { 40_000_000: 1, [SINGLE_BLOCK]: 1 },
    receipts: { [SINGLE_HASH]: SINGLE },
    ...options,
  });
}

const SINGLE_READ = {
  chain: MAINNET,
  tokens: [USDCE],
  recipients: [RECIPIENT],
  memo: SINGLE_MEMO,
  minAmount: 1n,
};

describe('readTempoReceiptLegs', () => {
  it('finds the memo leg of a recorded mainnet payment', async () => {
    const result = await readTempoReceiptLegs(mainnet().client, SINGLE_HASH, SINGLE_READ);
    expect(result.kind).toBe('legs');
    expect(result.kind === 'legs' && result.transfers[0]?.memo).toBe(SINGLE_MEMO);
    expect(result.kind === 'legs' && result.blockNumber).toBe(SINGLE_BLOCK);
  });

  it('answers absent for a hash the endpoint does not know', async () => {
    const result = await readTempoReceiptLegs(
      mainnet({ receipts: {} }).client,
      `0x${'12'.repeat(32)}`,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'absent' });
  });

  it.each([
    ['another memo', { memo: `0x${'ab'.repeat(32)}` }],
    ['another recipient', { recipients: [`0x${'cd'.repeat(20)}`] }],
    ['the other registry coin', { tokens: [PATHUSD] }],
    ['a price above the leg', { minAmount: 10n ** 30n }],
  ])('answers none for %s', async (_label, change) => {
    const result = await readTempoReceiptLegs(mainnet().client, SINGLE_HASH, {
      ...SINGLE_READ,
      ...change,
    });
    expect(result).toEqual({ kind: 'none' });
  });

  it('answers none for a reverted transaction', async () => {
    const reverted = { ...SINGLE, status: '0x0' };
    const result = await readTempoReceiptLegs(
      mainnet({ receipts: { [SINGLE_HASH]: reverted } }).client,
      SINGLE_HASH,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('is unreadable for a receipt that names another transaction', async () => {
    const result = await readTempoReceiptLegs(
      mainnet({
        receipts: { [SINGLE_HASH]: { ...SINGLE, transactionHash: `0x${'34'.repeat(32)}` } },
      }).client,
      SINGLE_HASH,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'unreadable' });
  });

  it('is unreadable, never none, for a block not yet finalized', async () => {
    const result = await readTempoReceiptLegs(
      mainnet({
        finalized: SINGLE_BLOCK - 1,
        timestamps: { [SINGLE_BLOCK - 1]: 1, [SINGLE_BLOCK]: 1 },
      }).client,
      SINGLE_HASH,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'unreadable' });
  });

  it('is unreadable for a receipt whose block is not this chain', async () => {
    const result = await readTempoReceiptLegs(
      mainnet({ blockHashes: { [SINGLE_BLOCK]: `0x${'ee'.repeat(32)}` } }).client,
      SINGLE_HASH,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'unreadable' });
  });

  it('is unreadable when the endpoint names the other Tempo network', async () => {
    const result = await readTempoReceiptLegs(mainnet({ chainId: '0xa5bf' }).client, SINGLE_HASH, {
      ...SINGLE_READ,
      memo: `0x${'ab'.repeat(32)}`,
    });
    expect(result).toEqual({ kind: 'unreadable' });
  });

  it('is unreadable when the endpoint does not answer', async () => {
    const chain = mainnet();
    const failing = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_getTransactionReceipt') {
          throw new Error('down');
        }
        return chain.client.request(args);
      },
    };
    expect(await readTempoReceiptLegs(failing, SINGLE_HASH, SINGLE_READ)).toEqual({
      kind: 'unreadable',
    });
  });

  it('ignores a transfer log that names another transaction', async () => {
    const logs = (SINGLE.logs as Record<string, unknown>[]).map((log) => ({
      ...log,
      transactionHash: `0x${'78'.repeat(32)}`,
    }));
    const result = await readTempoReceiptLegs(
      mainnet({ receipts: { [SINGLE_HASH]: { ...SINGLE, logs } } }).client,
      SINGLE_HASH,
      SINGLE_READ,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('reports a transfer the recipient policy blocked', async () => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: 1, [BLOCKED_BLOCK]: 1 },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const result = await readTempoReceiptLegs(chain.client, BLOCKED_HASH, {
      chain: MODERATO,
      tokens: [PATHUSD],
      recipients: [BLOCKED_RECEIVER],
      memo: BLOCKED_MEMO,
      minAmount: 1n,
    });
    expect(result.kind).toBe('legs');
    expect(result.kind === 'legs' && result.transfers).toEqual([]);
    expect(result.kind === 'legs' && result.blocked).toHaveLength(1);
  });

  it('ignores a guard log that names another transaction', async () => {
    const logs = (BLOCKED.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC
        ? { ...log, transactionHash: `0x${'56'.repeat(32)}` }
        : log,
    );
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: 1, [BLOCKED_BLOCK]: 1 },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs } },
    });
    const result = await readTempoReceiptLegs(chain.client, BLOCKED_HASH, {
      chain: MODERATO,
      tokens: [PATHUSD],
      recipients: [BLOCKED_RECEIVER],
      memo: BLOCKED_MEMO,
      minAmount: 1n,
    });
    expect(result).toEqual({ kind: 'none' });
  });
});
