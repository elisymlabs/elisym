import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  type OrderCommand,
  commandArgs,
  commandConsequence,
  commandStateOf,
  ordersReadOf,
  refundSubunits,
  refundTxOf,
  shownAmount,
  txLink,
} from '../../src/cloud/lib/orders';
import { payoutAssets } from '../../src/cloud/lib/payouts';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN = 'solana:nowhere/token:nothing';

/**
 * What cloud-api serves for a ledger with these orders (a paid one, an unpaid one, a closed one
 * and one answered by hand), as its own reader wrote it: a contract test in the cloud repo checks
 * this file against the reader.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/orders-served.json');

function served(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

describe('reading the orders', () => {
  it('reads every field cloud-api serves, as its reader writes them', () => {
    expect(ordersReadOf(served())).toEqual({
      orders: [
        {
          key: 'buyer2:o2',
          createdAt: 300,
          product: '30402:store:course',
          email: null,
          customerRef: null,
          payment: null,
          deliveredAt: null,
          webhook: null,
          feeUnresolved: ['tx2'],
          blockedTx: 'tx3',
        },
        {
          key: 'buyer1:o1',
          createdAt: 200,
          product: '30402:store:course',
          email: 'a@b.test',
          customerRef: 'cust-7',
          payment: {
            signature: 'sig1',
            amount: '1500000',
            fee: '5000',
            asset: USDC,
            paidAt: 210,
          },
          deliveredAt: 212,
          webhook: { state: 'failed', attempts: 3, lastStatus: 500, lastError: 'took 3 tries' },
          feeUnresolved: [],
          blockedTx: null,
        },
      ],
      answeredByHand: [
        { key: 'buyer4:o4', kind: 'refunded', tx: 'sig4', amount: '700', asset: USDC },
      ],
      closed: ['buyer3:o3', 'buyer4:o4'],
      unresolvedPayments: [{ key: 'buyer3:o3', tx: 'tx9', at: 400 }],
    });
  });

  it('refuses an answer with any field not what it must be', () => {
    const broken: ((body: Record<string, unknown>) => void)[] = [
      (body) => {
        body.orders = 'x';
      },
      (body) => {
        delete body.closed;
      },
      (body) => {
        body.closed = [1];
      },
      (body) => {
        body.answeredByHand = [{ key: 'k', kind: 'lost', tx: null, amount: null, asset: null }];
      },
      (body) => {
        body.answeredByHand = [
          { key: 'k', kind: 'refunded', tx: null, amount: '1.5', asset: null },
        ];
      },
      (body) => {
        body.unresolvedPayments = [{ key: 'k', tx: 't', at: -1 }];
      },
    ];
    const orderBreaks: ((order: Record<string, unknown>) => void)[] = [
      (order) => {
        order.createdAt = 1.5;
      },
      (order) => {
        order.email = undefined;
      },
      (order) => {
        order.feeUnresolved = [3];
      },
      (order) => {
        order.payment = { signature: 's', amount: '-1', fee: '0', asset: USDC, paidAt: 1 };
      },
      (order) => {
        order.payment = { signature: 's', amount: '1', fee: '0', asset: USDC };
      },
      (order) => {
        order.payment = { signature: 's', amount: '1', fee: '0.5', asset: USDC, paidAt: 1 };
      },
      (order) => {
        order.webhook = { state: 'lost', attempts: 0, lastStatus: null, lastError: null };
      },
      (order) => {
        order.webhook = { state: 'sent', attempts: 0, lastStatus: '200', lastError: null };
      },
    ];
    for (const breakIt of broken) {
      const body = JSON.parse(JSON.stringify(served()));
      breakIt(body);
      expect(ordersReadOf(body)).toBeUndefined();
    }
    for (const breakIt of orderBreaks) {
      const body = JSON.parse(JSON.stringify(served()));
      breakIt(body.orders[1]);
      expect(ordersReadOf(body)).toBeUndefined();
    }
    expect(ordersReadOf(null)).toBeUndefined();
  });
});

describe('amounts and transactions', () => {
  it('shows a registry coin in its units, anything else as its subunits and asset', () => {
    expect(shownAmount('1500000', USDC)).toBe('1.5 USDC');
    expect(shownAmount('700', UNKNOWN)).toBe(`700 subunits of ${UNKNOWN}`);
  });

  it("links a transaction on its chain's explorer only when the chain is known", () => {
    expect(txLink('sig1', USDC)).toContain('sig1');
    expect(txLink('sig1', UNKNOWN)).toBeUndefined();
  });

  it("reads a refund typed in the coin's units as subunits, refusing what the coin cannot take", () => {
    expect(refundSubunits(' 1.5 ', USDC)).toBe('1500000');
    expect(refundSubunits('0.000001', USDC)).toBe('1');
    for (const bad of ['', 'abc', '0', '-1', '1.0000001', '1e3']) {
      expect(refundSubunits(bad, USDC)).toBeUndefined();
    }
    expect(refundSubunits('1', UNKNOWN)).toBeUndefined();
  });
});

const SIGNATURE = base58.encode(new Uint8Array(64).fill(7));
const TEMPO_HASH = `0x${'ab'.repeat(32)}`;
const TEMPO_ASSET = payoutAssets('mainnet', new Set(['tempo']))[0]?.caip19 ?? '';
const BASE_ASSET = payoutAssets('mainnet', new Set(['base']))[0]?.caip19 ?? '';

describe('refund transactions', () => {
  it('takes a Solana signature for a Solana coin, and a Tempo hash (lowercased) for a Tempo one', () => {
    expect(TEMPO_ASSET).not.toBe('');
    expect(refundTxOf(` ${SIGNATURE} `, USDC)).toBe(SIGNATURE);
    expect(refundTxOf(TEMPO_HASH.toUpperCase().replace('0X', '0x'), TEMPO_ASSET)).toBe(TEMPO_HASH);
  });

  it('refuses a transaction of another rail, a malformed one, and a coin whose refunds the node does not read', () => {
    expect(refundTxOf(TEMPO_HASH, USDC)).toBeUndefined();
    expect(refundTxOf(SIGNATURE, TEMPO_ASSET)).toBeUndefined();
    expect(refundTxOf(base58.encode(new Uint8Array(63).fill(7)), USDC)).toBeUndefined();
    expect(refundTxOf('not base58 0OIl', USDC)).toBeUndefined();
    expect(refundTxOf(`${TEMPO_HASH}0`, TEMPO_ASSET)).toBeUndefined();
    expect(BASE_ASSET).not.toBe('');
    expect(refundTxOf(TEMPO_HASH, BASE_ASSET)).toBeUndefined();
    expect(refundTxOf(SIGNATURE, UNKNOWN)).toBeUndefined();
  });
});

describe('owner commands', () => {
  const commands: OrderCommand[] = [
    { kind: 'complete', key: 'buyer2:o2', again: false },
    {
      kind: 'refund',
      key: 'buyer2:o2',
      tx: 'sig5',
      amount: '1500000',
      asset: USDC,
      again: false,
    },
    { kind: 'webhook retry', key: 'buyer1:o1' },
    { kind: 'webhook resend', key: 'buyer1:o1' },
    { kind: 'complete', key: 'buyer4:o4', again: true },
    { kind: 'refund', key: 'buyer4:o4', tx: 'sig4', amount: '700', asset: null, again: true },
  ];

  it('builds each command as the node takes it', () => {
    expect(commands.map((command) => commandArgs(command))).toEqual([
      ['complete', 'buyer2:o2'],
      ['refund', 'buyer2:o2', '--tx', 'sig5', '--amount', '1500000', '--asset', USDC],
      ['webhook', 'retry', 'buyer1:o1'],
      ['webhook', 'resend', 'buyer1:o1'],
      ['complete', 'buyer4:o4'],
      // An answer kept without an asset is sent again without one.
      ['refund', 'buyer4:o4', '--tx', 'sig4', '--amount', '700'],
    ]);
    // That cloud-api's own check takes each is a contract test in the cloud repo.
  });

  it('refuses a value the store cannot take, or one that would read as a flag', () => {
    expect(commandArgs({ kind: 'complete', key: '--yes', again: false })).toBeUndefined();
    expect(commandArgs({ kind: 'complete', key: 'a b', again: false })).toBeUndefined();
    expect(commandArgs({ kind: 'webhook retry', key: '' })).toBeUndefined();
    expect(commandArgs({ kind: 'webhook resend', key: '-k' })).toBeUndefined();
    const refund = {
      kind: 'refund',
      key: 'b:o',
      tx: 't',
      amount: '1',
      asset: USDC,
      again: false,
    } as const;
    expect(commandArgs({ ...refund, tx: '-x' })).toBeUndefined();
    expect(commandArgs({ ...refund, tx: 't'.repeat(257) })).toBeUndefined();
    expect(commandArgs({ ...refund, amount: '-1' })).toBeUndefined();
    expect(commandArgs({ ...refund, asset: '-a' })).toBeUndefined();
  });

  it('says what each command does before it is confirmed', () => {
    expect(commands.map((command) => commandConsequence(command))).toEqual([
      'Close order buyer2:o2 and send the buyer "completed". It sends no webhook: credit it by hand.',
      'Close order buyer2:o2 and tell the buyer you refunded 1.5 USDC in sig5. Send the refund yourself first: this only reports it.',
      'Send the order.paid webhook of buyer1:o1 again now.',
      'Send the order.paid webhook of buyer1:o1 once more. Your receiver dedupes on its event id.',
      'Send the "completed" answer of order buyer4:o4 once more: the order is closed already, and the buyer may not have it yet.',
      'Send the refund report of order buyer4:o4 (700 subunits in sig4) once more: the order is closed already, and the buyer may not have it yet.',
    ]);
  });

  it("reads a command's cycle: waiting, done with its output, replaced, or failed with the store's own words", () => {
    expect(commandStateOf({ status: 'queued' })).toEqual({ stage: 'waiting' });
    expect(commandStateOf({ status: 'running' })).toEqual({ stage: 'waiting' });
    expect(commandStateOf({ status: 'done', outcome: null })).toEqual({
      stage: 'done',
      output: '',
    });
    expect(
      commandStateOf({
        status: 'done',
        outcome: { stdout: '\norder b:o\nwarning  sent again\n\n' },
      }),
    ).toEqual({ stage: 'done', output: 'order b:o\nwarning  sent again' });
    expect(commandStateOf({ status: 'done', outcome: { stdout: 'y'.repeat(3000) } })).toEqual({
      stage: 'done',
      output: 'y'.repeat(2000),
    });
    expect(commandStateOf({ status: 'replaced' })).toEqual({ stage: 'replaced' });
    expect(
      commandStateOf({
        status: 'failed',
        outcome: { message: 'exit 1', stderr: '\n  Error: no order b:o in the ledger\nat x' },
      }),
    ).toEqual({ stage: 'failed', reason: 'Error: no order b:o in the ledger', retried: false });
    expect(
      commandStateOf({ status: 'failed', outcome: { message: 'exit 1', stderr: '' } }),
    ).toEqual({ stage: 'failed', reason: 'exit 1', retried: false });
    expect(commandStateOf({ status: 'failed', outcome: null })).toEqual({
      stage: 'failed',
      reason: 'the store did not say why',
      retried: false,
    });
    expect(commandStateOf({ status: 'failed', outcome: { stderr: 'x'.repeat(500) } })).toEqual({
      stage: 'failed',
      reason: 'x'.repeat(300),
      retried: false,
    });
    // Retried by the cloud as a new cycle: still under way; any other verdict is final.
    expect(
      commandStateOf({ status: 'failed', outcome: { verdict: 'retry', message: 'relay down' } }),
    ).toEqual({ stage: 'failed', reason: 'relay down', retried: true });
    expect(
      commandStateOf({
        status: 'failed',
        outcome: { verdict: 'owner-refusal', stderr: 'refused owner-resign: x' },
      }),
    ).toEqual({ stage: 'failed', reason: 'refused owner-resign: x', retried: false });
    expect(commandStateOf({ status: 'lost' })).toBeUndefined();
    expect(commandStateOf('done')).toBeUndefined();
  });
});
