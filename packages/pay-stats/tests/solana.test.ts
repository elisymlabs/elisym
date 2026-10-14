import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { classifySolanaTransaction, scanSolana, tagSignatures } from '../src/solana';
import {
  MEMO,
  OTHER_REFERENCE,
  PAYER,
  PAYER_ATA,
  PAYOUT,
  PAYOUT_ATA,
  REFERENCE,
  TREASURY,
  TREASURY_ATA,
  landedJson,
  memo,
  solTransfer,
  usdcTransfer,
} from './solana-fixtures';

const TREASURIES = new Set([TREASURY]);
const OWNERS = { [PAYER_ATA]: PAYER, [PAYOUT_ATA]: PAYOUT, [TREASURY_ATA]: TREASURY };

function classify(transaction: unknown, treasuries: ReadonlySet<string> = TREASURIES) {
  return classifySolanaTransaction(transaction, 'sig-a', 'mainnet', treasuries);
}

describe('classifySolanaTransaction', () => {
  it('reads a commerce SPL payment with its fee leg', () => {
    const transaction = landedJson(
      [
        memo('elisym:commerce'),
        usdcTransfer(PAYER_ATA, PAYOUT_ATA, 48_510_000n),
        usdcTransfer(PAYER_ATA, TREASURY_ATA, 490_000n),
      ],
      { tokenOwners: OWNERS, slot: 77 },
    );
    expect(classify(transaction)).toEqual({
      kind: 'commerce',
      candidate: {
        rail: 'solana',
        network: 'mainnet',
        reference: REFERENCE,
        day: '2026-10-20',
        position: { primary: 77, secondary: 'sig-a' },
        coin: 'USDC',
        payout: PAYOUT,
        provider: 48_510_000n,
        fees: [{ treasury: TREASURY, amount: 490_000n }],
      },
    });
  });

  it('reads a commerce SOL payment, with no USD peg', () => {
    const transaction = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 5_000n)]);
    expect(classify(transaction)).toMatchObject({
      kind: 'commerce',
      candidate: { coin: 'SOL', payout: PAYOUT, provider: 5_000n, fees: [] },
    });
  });

  it('finds the payout owner of a token account served from a lookup table', () => {
    const transaction = landedJson(
      [memo('elisym:commerce'), usdcTransfer(PAYER_ATA, PAYOUT_ATA, 9n)],
      { tokenOwners: OWNERS, loaded: { writable: [PAYOUT_ATA], readonly: [REFERENCE] } },
    );
    expect(classify(transaction)).toMatchObject({
      kind: 'commerce',
      candidate: { payout: PAYOUT, provider: 9n, reference: REFERENCE },
    });
  });

  it.each([
    ['a job memo', [memo('elisym:v1:abc')], 'job'],
    ['both memos', [memo('elisym:commerce'), memo('elisym:v1:abc')], 'ambiguous'],
    ['no memo', [], 'untagged'],
    ['another memo', [memo('hello')], 'untagged'],
  ])('puts a payment with %s in its context bucket', (_label, memos, bucket) => {
    const transaction = landedJson([...memos, solTransfer(PAYER, PAYOUT, 5_000n)]);
    expect(classify(transaction)).toEqual({ kind: 'context', day: '2026-10-20', bucket });
  });

  it('ignores a commerce memo inside another program call', () => {
    const transaction = landedJson([solTransfer(PAYER, PAYOUT, 5_000n)], {
      inner: [memo('elisym:commerce')],
    });
    expect(classify(transaction)).toMatchObject({ kind: 'context', bucket: 'untagged' });
  });

  it('leaves out a failed transaction, a self-transfer, a zero amount and an unbound one', () => {
    const failed = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 5_000n)], {
      err: { InstructionError: [0, 'Custom'] },
    });
    expect(classify(failed)).toEqual({ kind: 'skip' });
    const self = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYER, 5_000n)]);
    expect(classify(self)).toEqual({ kind: 'skip' });
    const zero = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 0n)]);
    expect(classify(zero)).toEqual({ kind: 'skip' });
    const untagged = solTransfer(PAYER, PAYOUT, 5_000n);
    const noTag = landedJson([
      memo('elisym:commerce'),
      { ...untagged, accounts: untagged.accounts.slice(0, 3) },
    ]);
    expect(classify(noTag)).toEqual({ kind: 'skip' });
  });

  it('counts a transfer under another reference as extra', () => {
    const transaction = landedJson(
      [
        memo('elisym:commerce'),
        usdcTransfer(PAYER_ATA, PAYOUT_ATA, 10n),
        usdcTransfer(PAYER_ATA, PAYOUT_ATA, 1_000n, OTHER_REFERENCE),
        usdcTransfer(PAYER_ATA, TREASURY_ATA, 3n, OTHER_REFERENCE),
      ],
      { tokenOwners: OWNERS },
    );
    expect(classify(transaction)).toMatchObject({
      kind: 'commerce',
      candidate: { reference: REFERENCE, provider: 10n, fees: [] },
    });
  });

  it('puts a payment with only treasury legs in treasury_only', () => {
    const transaction = landedJson(
      [memo('elisym:commerce'), usdcTransfer(PAYER_ATA, TREASURY_ATA, 3n)],
      { tokenOwners: OWNERS },
    );
    expect(classify(transaction)).toEqual({
      kind: 'context',
      day: '2026-10-20',
      bucket: 'treasury_only',
    });
    // Without the treasury known, that leg is the provider's.
    expect(classify(transaction, new Set())).toMatchObject({
      kind: 'commerce',
      candidate: { payout: TREASURY, provider: 3n },
    });
  });

  it('dates by the UTC day of the block time', () => {
    const midnight = Date.parse('2026-10-21T00:00:00Z') / 1000;
    const before = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 1n)], {
      blockTime: midnight - 1,
    });
    const after = landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 1n)], {
      blockTime: midnight,
    });
    expect(classify(before)).toMatchObject({ candidate: { day: '2026-10-20' } });
    expect(classify(after)).toMatchObject({ candidate: { day: '2026-10-21' } });
  });

  it('checks the memo program, not only the bytes', () => {
    const fake = { ...memo('elisym:commerce'), program: TREASURY };
    const transaction = landedJson([fake, solTransfer(PAYER, PAYOUT, 5_000n)]);
    expect(classify(transaction)).toMatchObject({ kind: 'context', bucket: 'untagged' });
    expect(MEMO).not.toBe(TREASURY);
  });
});

/** A node answering signature pages and transactions from memory. */
function rpcWith(
  pages: { signature: string; slot: bigint; blockTime: bigint | null; err: unknown }[][],
  transactions: Record<string, unknown>,
) {
  const asked: { before?: string }[] = [];
  const rpc = {
    getSignaturesForAddress: (_address: string, config: { before?: string }) => ({
      send: async () => {
        asked.push(config);
        return pages[asked.length - 1] ?? [];
      },
    }),
    getTransaction: (signature: string) => ({
      send: async () => transactions[signature] ?? null,
    }),
  };
  return { rpc: rpc as unknown as Rpc<SolanaRpcApi>, asked };
}

describe('the tag history', () => {
  const launch = Date.parse('2026-10-20T00:00:00Z') / 1000;

  it('pages back to the launch, leaving out failed transactions', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({
      signature: `s${index}`,
      slot: BigInt(5000 - index),
      blockTime: BigInt(launch + 5000 - index),
      err: index === 3 ? { failed: true } : null,
    }));
    const second = [
      { signature: 'late', slot: 10n, blockTime: BigInt(launch + 1), err: null },
      { signature: 'old', slot: 9n, blockTime: BigInt(launch - 1), err: null },
      { signature: 'older', slot: 8n, blockTime: BigInt(launch - 2), err: null },
    ];
    const { rpc, asked } = rpcWith([full, second], {});
    const found = await tagSignatures(rpc, launch);
    expect(found).toHaveLength(1000);
    expect(found.map((entry) => entry.signature)).not.toContain('s3');
    expect(found.at(-1)?.signature).toBe('late');
    expect(asked.map((config) => config.before)).toEqual([undefined, 's999']);
  });

  it('classifies what it reads, and refuses a node that does not serve a transaction', async () => {
    const page = [
      { signature: 'c', slot: 3n, blockTime: BigInt(launch + 10), err: null },
      { signature: 'j', slot: 2n, blockTime: BigInt(launch + 5), err: null },
    ];
    const { rpc } = rpcWith([page], {
      c: landedJson([memo('elisym:commerce'), solTransfer(PAYER, PAYOUT, 7n)]),
      j: landedJson([memo('elisym:v1:x'), solTransfer(PAYER, PAYOUT, 7n)]),
    });
    const scan = await scanSolana(rpc, 'mainnet', launch, new Set());
    expect(scan.candidates.map((candidate) => candidate.provider)).toEqual([7n]);
    expect(scan.context).toEqual([{ day: '2026-10-20', rail: 'solana', bucket: 'job', count: 1 }]);
    const { rpc: missing } = rpcWith([page], {});
    await expect(scanSolana(missing, 'mainnet', launch, new Set())).rejects.toThrow(
      'does not serve',
    );
  });
});
