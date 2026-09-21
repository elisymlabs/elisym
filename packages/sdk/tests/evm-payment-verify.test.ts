/**
 * Issuing a Tempo payment request, and deciding whether it was paid.
 *
 * The verify rows run over RECORDED mainnet and Moderato receipts, mutated
 * minimally, through a client that evaluates the `eth_getLogs` filter rather
 * than answering a blanket list. What each row must come out as is listed in
 * the facts file beside the plan.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearEvmProtocolConfigCache } from '../src/evm/config';
import {
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from '../src/evm/constants';
import { readTempoReceivePolicy } from '../src/evm/policy';
import { createTempoPaymentRequest } from '../src/evm/request';
import { verifyTempoPayment } from '../src/evm/verify';
import { ALL_ASSETS, PATHUSD_TEMPO, USDCE_TEMPO_MAINNET } from '../src/payment/assets';
import { CHAINS } from '../src/payment/chains';
import { PaymentRequestV2Schema } from '../src/payment/schema-v2';
import type { FakeChainOptions, FakeLog } from './tempo-chain';
import { fakeTempoChain, rangeCapError, recordedReceipt, receiptLogs } from './tempo-chain';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const RECIPIENT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const TREASURY = '0x7edb1404ebae28332867756c0d01440b9e63f3f7';
const BLOCKED_RECEIVER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

const BATCH = recordedReceipt('mainnet-batch-relayed');
const BATCH_HASH = String(BATCH.transactionHash);
const BATCH_BLOCK = Number(BigInt(String(BATCH.blockNumber)));
const BATCH_MEMO = '0xe212c3626c6a7e1d7ea87da9bc16cd19de2f3478e76e47691f95a6fc4aec4634';

const SINGLE = recordedReceipt('mainnet-single-in-7702');
const SINGLE_HASH = String(SINGLE.transactionHash);
const SINGLE_BLOCK = Number(BigInt(String(SINGLE.blockNumber)));
const SINGLE_MEMO = '0x77736adb5138f60729b744b0e050858c88891a2f9f9317ec623956e99103bb04';

const BLOCKED = recordedReceipt('moderato-blocked-pathusd');
const BLOCKED_HASH = String(BLOCKED.transactionHash);
const BLOCKED_BLOCK = Number(BigInt(String(BLOCKED.blockNumber)));
const BLOCKED_MEMO = '0x626c6f636b65642073656e646572000000000000000000000000000000000000';

const NOW = 1_700_000_000;
/** Past the expiry AND the late grace: the moment a verdict of absence is allowed. */
const PAST_DEADLINE = NOW + 60 + 600 + 1800 + 1;

/**
 * Ordinary traffic on the same token at both ends of a scan. Without it the
 * history control cannot vouch for the endpoint, and no verdict that rests on
 * an empty window may be reached - which is the point of it.
 */
function controlTraffic(floorBlock: number, headBlock: number, token = USDCE): FakeLog[] {
  return [floorBlock, headBlock].map((blockNumber, index) => ({
    address: token,
    topics: [`0x${'55'.repeat(32)}`],
    data: '0x',
    blockNumber,
    transactionHash: `0x${String(index + 2)
      .repeat(2)
      .repeat(32)}`,
    logIndex: 0,
  }));
}

interface RequestFields {
  chain?: string;
  asset?: string;
  recipient?: string;
  amount?: string;
  fee_address?: string;
  fee_amount?: string;
  memo?: string;
  created_at?: number;
  expiry_secs?: number;
}

function requestOf(fields: RequestFields) {
  return PaymentRequestV2Schema.parse({
    v: 2,
    chain: 'eip155:4217',
    asset: `eip155:4217/erc20:${USDCE}`,
    recipient: RECIPIENT,
    amount: '10000',
    memo: BATCH_MEMO,
    created_at: NOW - 60,
    expiry_secs: 600,
    ...fields,
  });
}

/** Every fixture row takes `created_at` 60 s before its block and a floor 100 blocks below. */
function chainWith(options: FakeChainOptions = {}) {
  return fakeTempoChain({
    finalized: 40_000_000,
    timestamps: { 40_000_000: NOW, [BATCH_BLOCK]: NOW, [SINGLE_BLOCK]: NOW },
    ...options,
  });
}

/**
 * The same chain seen after the payment window has CLOSED, with ordinary
 * traffic at both ends of the scan.
 *
 * Every by-hash REFUSAL row runs on it. A refusal is terminal, and the memo
 * scan can still find the money while the window is open - a customer whose
 * wallet cannot batch pays the two legs seconds apart and reports the first
 * hash - so "that hash did not pay this" is an answer only once the second
 * look is possible and comes back empty. Inside the window the same rows are
 * inconclusive on purpose; two named rows below pin both halves.
 */
function settledChain(floorBlock: number, options: FakeChainOptions = {}) {
  return chainWith({
    ...options,
    timestamps: {
      40_000_000: PAST_DEADLINE,
      [BATCH_BLOCK]: NOW,
      [SINGLE_BLOCK]: NOW,
      ...options.timestamps,
    },
    logs: [...controlTraffic(floorBlock - 50, 39_999_900), ...(options.logs ?? [])],
  });
}

beforeEach(() => {
  clearEvmProtocolConfigCache();
});

describe('verifyTempoPayment - by hash, over recorded receipts', () => {
  it('credits the recorded BATCH: two legs, a fee, paid by a relayer', async () => {
    // The transaction's `from` is the relayer, not the customer, and no check
    // here looks at it: a leg found by memo counts as done whoever paid it.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ amount: '20000', fee_address: TREASURY, fee_amount: '10000' }),
      { txSignature: BATCH_HASH, fromBlock: BATCH_BLOCK - 100 },
    );
    expect(result).toMatchObject({
      outcome: 'verified',
      settlementId: `eip155:4217:${BATCH_HASH}:${BATCH_MEMO}`,
    });
    expect(result.outcome === 'verified' && result.feeLeg?.amount).toBe(10_000n);
  });

  it.each([
    ['a second relayed batch, fee > 0', 'mainnet-batch-relayed-2', true],
    ['a second single transfer, fee 0', 'mainnet-single-relayed', false],
  ])('credits %s', async (_label, name, hasFee) => {
    // Every recorded receipt in the facts table is asserted, not just the two
    // the first rows happened to use.
    const receipt = recordedReceipt(name);
    const hash = String(receipt.transactionHash);
    const block = Number(BigInt(String(receipt.blockNumber)));
    const legs = receiptLogs(receipt)
      .filter((log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC)
      .map((log) => ({
        to: `0x${log.topics[2].slice(26)}`,
        memo: log.topics[3],
        amount: BigInt(log.data),
      }));
    const provider = legs[0];
    const chain = chainWith({
      timestamps: { 40_000_000: NOW, [block]: NOW },
      receipts: { [hash]: receipt },
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({
        recipient: provider.to,
        memo: provider.memo,
        amount: hasFee ? (provider.amount + legs[1].amount).toString() : provider.amount.toString(),
        ...(hasFee ? { fee_address: legs[1].to, fee_amount: legs[1].amount.toString() } : {}),
      }),
      { txSignature: hash, fromBlock: block - 100 },
    );
    expect(result.outcome).toBe('verified');
  });

  it('credits the recorded SINGLE transfer inside a 7702 transaction, at fee 0', async () => {
    const chain = chainWith({ receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
    expect(result.outcome === 'verified' && result.feeLeg).toBeUndefined();
  });

  it.each([
    ['a memo that is not the one in the receipt', { memo: `0x${'ab'.repeat(32)}` }],
    ['another recipient', { recipient: `0x${'cd'.repeat(20)}` }],
    ['an amount above what the log carries', { amount: '10001' }],
  ])('refuses %s as no provider leg', async (_label, fields) => {
    const chain = settledChain(SINGLE_BLOCK - 100, { receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ memo: SINGLE_MEMO, ...fields }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('refuses the right payment claimed under the OTHER registry coin', async () => {
    // Rule 3 drops every log that is not the registry token's, so the leg is
    // simply not there - a token is not a field a request may rename. The
    // second look runs on the coin the REQUEST names, so that is the coin its
    // history has to be vouched for on.
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: SINGLE },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900, PATHUSD),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ memo: SINGLE_MEMO, asset: `eip155:4217/erc20:${PATHUSD}` }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('refuses a request whose coin is not in this SDK at all', async () => {
    const chain = chainWith({ receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ asset: `eip155:4217/erc20:0x${'11'.repeat(20)}` }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'unknown_asset' });
  });

  it('refuses when the endpoint is not the chain the request names', async () => {
    const chain = chainWith({ chainId: '0xa5bf', receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'wrong_chain' });
  });

  it('does not conclude anything when the chain id is unreadable', async () => {
    const chain = chainWith({ chainId: 7, receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
  });

  it('says NOT SEEN YET for a hash the node does not have - never "not paid"', async () => {
    const chain = chainWith({ receipts: {} });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'no_receipt' });
  });

  it('waits for finality rather than crediting a block above the finalized one', async () => {
    const chain = chainWith({
      finalized: SINGLE_BLOCK - 1,
      timestamps: { [SINGLE_BLOCK - 1]: NOW },
      receipts: { [SINGLE_HASH]: SINGLE },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_finalized' });
  });

  it('refuses a REVERTED transaction', async () => {
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: { ...SINGLE, status: '0x0' } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'reverted' });
  });

  it('ignores a log inside the receipt that names ANOTHER transaction', async () => {
    const logs = (SINGLE.logs as Record<string, unknown>[]).map((log) => ({
      ...log,
      transactionHash: `0x${'77'.repeat(32)}`,
    }));
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: { ...SINGLE, logs } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it.each([
    ['a status that is neither success nor failure', { status: '0x2' }],
    [
      'a transaction hash that is not the one asked for',
      { transactionHash: `0x${'99'.repeat(32)}` },
    ],
    ['a block number that will not parse', { blockNumber: 'soon' }],
    ['logs that are not a list', { logs: 'none' }],
  ])('refuses a receipt with %s as unreadable', async (_label, overrides) => {
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: { ...SINGLE, ...overrides } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'unreadable_receipt' });
  });
});

describe('verifyTempoPayment - a hash that names the wrong transaction', () => {
  it('looks past a receipt it could not READ, the same way', async () => {
    // A proxy that rewrites `status` into a JSON number makes every receipt
    // it serves unreadable. That is a fact about the receipt; the memo the
    // customer paid with is still on chain, in another transaction.
    const other = `0x${'7b'.repeat(32)}`;
    const chain = chainWith({
      receipts: {
        [other]: { ...SINGLE, transactionHash: other, status: 1, logs: [] },
        [SINGLE_HASH]: SINGLE,
      },
      logs: receiptLogs(SINGLE),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: other,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
  });

  it('finds the payment by memo when the reported hash paid nothing of ours', async () => {
    // A wallet reports a bundle id, an approve, or the first of two
    // transactions. The money is one eth_getLogs away and a refusal is
    // terminal, so what one transaction does not say is not the last word.
    const other = `0x${'7c'.repeat(32)}`;
    const chain = chainWith({
      receipts: {
        [other]: { ...SINGLE, transactionHash: other, logs: [] },
        [SINGLE_HASH]: SINGLE,
      },
      logs: receiptLogs(SINGLE),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: other,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
    expect(result.outcome === 'verified' && result.providerLeg.transactionHash).toBe(SINGLE_HASH);
  });

  it('looks past a REVERTED transaction to money that IS on chain', async () => {
    // A customer whose first attempt reverted pays again and reports the hash
    // it has. The reverted one says nothing about the second transaction, and
    // the memo is one `eth_getLogs` away.
    const reverted = `0x${'7d'.repeat(32)}`;
    const chain = chainWith({
      receipts: {
        [reverted]: { ...SINGLE, transactionHash: reverted, status: '0x0', logs: [] },
        [SINGLE_HASH]: SINGLE,
      },
      logs: receiptLogs(SINGLE),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: reverted,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
  });

  it('looks past a REVERTED transaction too, and keeps the refusal if nothing paid', async () => {
    const reverted = `0x${'7d'.repeat(32)}`;
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [reverted]: { ...SINGLE, transactionHash: reverted, status: '0x0' } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: reverted,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'reverted' });
  });

  it('does NOT bury an unknown under a refusal: a look that could not happen wins', async () => {
    // A wallet reports the wrong hash AND one eth_getLogs fails. The money is
    // on chain; a terminal refusal here fails the job for good. The same rule
    // the candidate loop applies one level down.
    const other = `0x${'7e'.repeat(32)}`;
    const chain = chainWith({
      receipts: {
        [other]: { ...SINGLE, transactionHash: other, logs: [] },
        [SINGLE_HASH]: SINGLE,
      },
      logs: receiptLogs(SINGLE),
      onGetLogs: () => new Error('the node fell over'),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: other,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'incomplete_scan' });
  });

  it('WAITS instead of refusing while the window the customer may still pay in is open', async () => {
    // The D15 payer: a wallet that cannot batch sends the fee leg and the
    // provider leg seconds apart and reports the first hash. That hash alone
    // says `no_provider_leg` - and the provider leg is in flight. A refusal is
    // terminal; "not due yet" costs the slot that every unpaid job costs.
    const other = `0x${'7f'.repeat(32)}`;
    const chain = chainWith({
      receipts: { [other]: { ...SINGLE, transactionHash: other, logs: [] } },
      logs: [],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: other,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
  });

  it('keeps the refusal once the window has closed and the second look found nothing', async () => {
    // Nothing is lost by waiting: past the deadline the scan answers `none`,
    // which is not an unknown, and the named transaction's verdict stands.
    const other = `0x${'7f'.repeat(32)}`;
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [other]: { ...SINGLE, transactionHash: other, logs: [] } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: other,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('does not bury an unknown under a refusal BETWEEN CANDIDATES either', async () => {
    // One (recipient, memo) pair, two transactions - the reviewer found a live
    // pair spread over 32. The earlier one's receipt comes back with no logs,
    // which is a terminal refusal; the later one is unreadable right now. The
    // unknown has to win, or the job dies while the money is still readable.
    const later = `0x${'6b'.repeat(32)}`;
    const memoLog = receiptLogs(SINGLE).filter((log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC);
    const chain = chainWith({
      receipts: { [SINGLE_HASH]: { ...SINGLE, logs: [] } },
      logs: [
        ...memoLog,
        ...memoLog.map((log) => ({
          ...log,
          transactionHash: later,
          blockNumber: log.blockNumber + 1,
        })),
      ],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'no_receipt' });
  });

  it('does not look past a refusal that stands on its own evidence', async () => {
    // A missing fee leg is about the REQUEST, not about one transaction, and
    // the second scan would only repeat the work the first one just did.
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: controlTraffic(BATCH_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ amount: '20000', fee_address: TREASURY, fee_amount: '10000' }),
      { txSignature: BATCH_HASH, fromBlock: BATCH_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
    // One pass. The memo scan reads the finalized head; the by-hash path reads
    // it once, and the fee-leg lookup is handed a number instead.
    const passes = chain.calls.filter(
      (call) => call.method === 'eth_getBlockByNumber' && call.params?.[0] === 'finalized',
    ).length;
    expect(passes).toBe(1);
  });

  it('keeps the blocked verdict when the second look finds nothing either', async () => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
      logs: receiptLogs(BLOCKED),
    });
    const result = await verifyTempoPayment(
      chain.client,
      PaymentRequestV2Schema.parse({
        v: 2,
        chain: 'eip155:42431',
        asset: `eip155:42431/erc20:${PATHUSD}`,
        recipient: BLOCKED_RECEIVER,
        amount: '25000000',
        memo: BLOCKED_MEMO,
        created_at: NOW - 60,
        expiry_secs: 600,
      }),
      { txSignature: BLOCKED_HASH, fromBlock: BLOCKED_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'provider_leg_blocked' });
  });

  it('ignores a guard log in the receipt that names ANOTHER transaction', async () => {
    // One crafted log would otherwise flip a paid job to a terminal refusal.
    const alien = receiptLogs(BLOCKED)
      .filter((log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC)
      .map((log) => ({ ...log, transactionHash: `0x${'aa'.repeat(32)}` }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: PAST_DEADLINE, [BLOCKED_BLOCK]: NOW },
      receipts: {
        [BLOCKED_HASH]: {
          ...BLOCKED,
          logs: [
            ...(BLOCKED.logs as Record<string, unknown>[]).filter(
              (log) => (log.topics as string[])[0] !== TRANSFER_BLOCKED_TOPIC,
            ),
            ...alien.map(wire),
          ],
        },
      },
      logs: controlTraffic(BLOCKED_BLOCK - 150, 35_789_900, PATHUSD),
    });
    const result = await verifyTempoPayment(
      chain.client,
      PaymentRequestV2Schema.parse({
        v: 2,
        chain: 'eip155:42431',
        asset: `eip155:42431/erc20:${PATHUSD}`,
        recipient: BLOCKED_RECEIVER,
        amount: '25000000',
        memo: BLOCKED_MEMO,
        created_at: NOW - 60,
        expiry_secs: 600,
      }),
      { txSignature: BLOCKED_HASH, fromBlock: BLOCKED_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });
});

describe('verifyTempoPayment - guards the receipt path owes', () => {
  it('ignores a guard log in the receipt that claims another BLOCK', async () => {
    // The transaction bound is not the whole bound: a receipt names one block
    // too, and an entry that claims a different one is not this receipt's
    // evidence either. One crafted log would otherwise flip a paid job to a
    // terminal refusal.
    const alien = receiptLogs(BLOCKED)
      .filter((log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC)
      .map((log) => ({ ...log, blockNumber: 1 }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: PAST_DEADLINE, [BLOCKED_BLOCK]: NOW },
      receipts: {
        [BLOCKED_HASH]: {
          ...BLOCKED,
          logs: [
            ...(BLOCKED.logs as Record<string, unknown>[]).filter(
              (log) => (log.topics as string[])[0] !== TRANSFER_BLOCKED_TOPIC,
            ),
            ...alien.map(wire),
          ],
        },
      },
      logs: controlTraffic(BLOCKED_BLOCK - 150, 35_789_900, PATHUSD),
    });
    const result = await verifyTempoPayment(
      chain.client,
      PaymentRequestV2Schema.parse({
        v: 2,
        chain: 'eip155:42431',
        asset: `eip155:42431/erc20:${PATHUSD}`,
        recipient: BLOCKED_RECEIVER,
        amount: '25000000',
        memo: BLOCKED_MEMO,
        created_at: NOW - 60,
        expiry_secs: 600,
      }),
      { txSignature: BLOCKED_HASH, fromBlock: BLOCKED_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  function receiptWith(logs: Record<string, unknown>[]) {
    return { ...SINGLE, logs };
  }

  const memoLog = (SINGLE.logs as Record<string, unknown>[]).find(
    (log) => (log.topics as string[])[0] === TRANSFER_WITH_MEMO_TOPIC,
  ) as Record<string, unknown>;

  it('does not credit a leg whose sides are equal, even inside a real receipt', async () => {
    // Free to forge: an infinite allowance makes `transferFromWithMemo(X, X)`
    // cost nothing, and there are real ones on mainnet with guessable memos.
    const topics = memoLog.topics as string[];
    const selfLeg = { ...memoLog, topics: [topics[0], topics[2], topics[2], topics[3]] };
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: receiptWith([selfLeg]) },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('does not accept a one-subunit fee leg', async () => {
    const topics = memoLog.topics as string[];
    const feeLeg = {
      ...memoLog,
      topics: [topics[0], topics[1], `0x${'0'.repeat(24)}${TREASURY.slice(2)}`, topics[3]],
      data: `0x${'1'.padStart(64, '0')}`,
      logIndex: '0x9',
    };
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [SINGLE_HASH]: receiptWith([memoLog, feeLeg]) },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({
        memo: SINGLE_MEMO,
        amount: '20000',
        fee_address: TREASURY,
        fee_amount: '10000',
      }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });

  it('does not accept a fee leg whose sides are equal', async () => {
    const topics = memoLog.topics as string[];
    const treasuryTopic = `0x${'0'.repeat(24)}${TREASURY.slice(2)}`;
    const feeLeg = {
      ...memoLog,
      topics: [topics[0], treasuryTopic, treasuryTopic, topics[3]],
      logIndex: '0x9',
    };
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [SINGLE_HASH]: receiptWith([memoLog, feeLeg]) },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({
        memo: SINGLE_MEMO,
        amount: '20000',
        fee_address: TREASURY,
        fee_amount: '10000',
      }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });
});

describe('verifyTempoPayment - the fee leg', () => {
  const feeRequest = requestOf({ amount: '20000', fee_address: TREASURY, fee_amount: '10000' });

  it('credits a batch SPLIT into two transactions, finding the fee leg by lookup', async () => {
    // What a wallet that cannot batch does (D15): the provider leg lands, then
    // the fee leg a moment later, in its own transaction.
    const logs = receiptLogs(BATCH);
    const providerLogs = logs.filter((log) => log.topics[2]?.endsWith(RECIPIENT.slice(2)));
    const feeLogs = logs.filter((log) => log.topics[2]?.endsWith(TREASURY.slice(2)));
    const feeHash = `0x${'fe'.repeat(32)}`;
    const chain = chainWith({
      receipts: {
        [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) },
        [feeHash]: { ...BATCH, transactionHash: feeHash, logs: feeLogs.map(wire) },
      },
      logs: feeLogs.map((log) => ({ ...log, transactionHash: feeHash })),
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
    expect(result.outcome === 'verified' && result.feeLeg?.transactionHash).toBe(feeHash);
  });

  it('refuses a fee leg that never arrived, once the window has closed', async () => {
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      // The chain has moved well past the request's expiry plus the grace.
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: controlTraffic(BATCH_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });

  it('does NOT refuse a fee leg that is merely late: the provider leg is already paid', async () => {
    // Refusing here would fail a job whose customer has already paid the
    // provider, and the second transaction may be seconds away.
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
  });

  it('says nothing at all when the fee-leg lookup could not finish', async () => {
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      timestamps: { 40_000_000: NOW + 60 + 600 + 1800 + 1 },
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      // Only the TOKEN lookup fails; the guard lookup answers normally, so the
      // two cannot cover for each other.
      onGetLogs: (call) =>
        call.address.toLowerCase() === USDCE ? new Error('the node fell over') : undefined,
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'incomplete_scan' });
  });

  it('refuses a fee address the receipt does not pay, with both legs on chain', async () => {
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [BATCH_HASH]: BATCH },
      logs: controlTraffic(BATCH_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({
        amount: '20000',
        fee_address: `0x${'ab'.repeat(20)}`,
        fee_amount: '10000',
      }),
      { txSignature: BATCH_HASH, fromBlock: BATCH_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });

  it('will not call a fee leg missing on an endpoint that cannot show its history', async () => {
    // "The fee leg is not on chain" is the same claim as "nobody paid", so it
    // takes the same proof. A node that under-serves this window answers an
    // empty list with no error - and the customer has ALREADY paid the provider.
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: [],
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'control_failed' });
  });
});

describe('verifyTempoPayment - a leg the recipient blocked', () => {
  const blockedRequest = () =>
    PaymentRequestV2Schema.parse({
      v: 2,
      chain: 'eip155:42431',
      asset: `eip155:42431/erc20:${PATHUSD}`,
      recipient: BLOCKED_RECEIVER,
      amount: '25000000',
      memo: BLOCKED_MEMO,
      created_at: NOW - 60,
      expiry_secs: 600,
    });

  /**
   * Rewrite one 32-byte word of a log's data. The guard's claim receipt must
   * agree with its own topics or the log decodes as unreadable - so a row that
   * moves a topic has to move the body word beside it, or it tests the decoder
   * instead of the rule it names.
   */
  function withDataWord(log: Record<string, unknown>, index: number, word: string) {
    const data = String(log.data);
    return {
      ...log,
      data: `${data.slice(0, 2 + index * 64)}${word}${data.slice(2 + (index + 1) * 64)}`,
    };
  }
  const BLOCKED_RECIPIENT_WORD = 8;
  const BLOCKED_MEMO_WORD = 13;

  function moderato(options: FakeChainOptions = {}) {
    return fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      ...options,
    });
  }

  /** `settledChain`'s rule, on Moderato: past the window, with history at both edges. */
  function settledModerato(options: FakeChainOptions = {}) {
    return moderato({
      ...options,
      timestamps: { 35_790_000: PAST_DEADLINE, [BLOCKED_BLOCK]: NOW, ...options.timestamps },
      logs: [...controlTraffic(BLOCKED_BLOCK - 150, 35_789_900, PATHUSD), ...(options.logs ?? [])],
    });
  }

  it('reads the guard log in the receipt and says the leg was BLOCKED, not missing', async () => {
    // The transaction succeeded and emitted no memo log. Without the guard log
    // this is indistinguishable from a payment that was never sent - and the
    // customer's money is sitting with the guard.
    const chain = moderato({ receipts: { [BLOCKED_HASH]: BLOCKED } });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: BLOCKED_HASH,
      fromBlock: BLOCKED_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'provider_leg_blocked' });
  });

  it('finds the same guard log WITHOUT a hash', async () => {
    const chain = moderato({
      logs: receiptLogs(BLOCKED),
      timestamps: { 35_790_000: NOW + 60 + 600 + 1800 + 1, [BLOCKED_BLOCK]: NOW },
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'provider_leg_blocked' });
  });

  it('ignores a guard log carrying another memo', async () => {
    // Same token, same receiver, a different payment. It says nothing about ours.
    const logs = receiptLogs(BLOCKED).map((log) =>
      log.topics[0] === TRANSFER_BLOCKED_TOPIC
        ? { ...log, data: `${log.data.slice(0, 2 + 13 * 64)}${'aa'.repeat(32)}` }
        : log,
    );
    const chain = moderato({
      logs,
      timestamps: { 35_790_000: NOW + 60 + 600 + 1800 + 1, [BLOCKED_BLOCK]: NOW },
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).not.toBe('refused');
  });

  it('ignores a guard log whose amount does not cover the leg', async () => {
    const logs = receiptLogs(BLOCKED).map((log) =>
      log.topics[0] === TRANSFER_BLOCKED_TOPIC
        ? { ...log, data: `0x${'0'.repeat(63)}1${log.data.slice(66)}` }
        : log,
    );
    const chain = moderato({
      logs,
      timestamps: { 35_790_000: NOW + 60 + 600 + 1800 + 1, [BLOCKED_BLOCK]: NOW },
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).not.toBe('refused');
  });

  it('reports the blocked leg the second look found, not the wrong hash', async () => {
    // Both refuse. "That hash is not this payment" says only that somebody
    // named the wrong transaction; the guard log says the money left the
    // customer and the recipient's policy bounced it - which is the one
    // distinction that tells an operator where to look for it.
    const other = `0x${'7a'.repeat(32)}`;
    const chain = settledModerato({
      receipts: {
        [other]: { ...BLOCKED, transactionHash: other, logs: [] },
        [BLOCKED_HASH]: BLOCKED,
      },
      logs: receiptLogs(BLOCKED),
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: other,
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'provider_leg_blocked' });
  });

  it('ignores a guard log for another RECEIVER that carries our memo', async () => {
    // Inside a receipt nothing is topic-filtered, so this is the only thing
    // that binds a guard log to the leg it is read as. Without it a job whose
    // provider leg is already paid reads as blocked.
    const stranger = `${'0'.repeat(24)}${'cd'.repeat(20)}`;
    const elsewhere = (BLOCKED.logs as Record<string, unknown>[]).map((log) => {
      const topics = log.topics as string[];
      if (topics[0] !== TRANSFER_BLOCKED_TOPIC) {
        return log;
      }
      const moved = withDataWord(log, BLOCKED_RECIPIENT_WORD, stranger);
      return { ...moved, topics: [topics[0], topics[1], `0x${stranger}`, topics[3]] };
    });
    const chain = settledModerato({
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs: elsewhere } },
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: BLOCKED_HASH,
      fromBlock: BLOCKED_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('ignores a guard log for another token that carries OUR memo', async () => {
    // Same receipt, same receiver, the same memo - and a different coin. Only
    // the token tells them apart, and reading it as ours would report money as
    // blocked that this request never asked anyone to send.
    const otherToken = '0x20c000000000000000000000bbe99c4c258a8db7';
    const logs = (BLOCKED.logs as Record<string, unknown>[]).map((log) => {
      const topics = log.topics as string[];
      if (topics[0] !== TRANSFER_BLOCKED_TOPIC) {
        return log;
      }
      const data = String(log.data);
      const tokenWord = `${'0'.repeat(24)}${otherToken.slice(2)}`;
      return {
        ...log,
        topics: [topics[0], `0x${tokenWord}`, topics[2], topics[3]],
        data: `${data.slice(0, 2 + 5 * 64)}${tokenWord}${data.slice(2 + 6 * 64)}`,
      };
    });
    const chain = settledModerato({ receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs } } });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: BLOCKED_HASH,
      fromBlock: BLOCKED_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('ignores a guard log in the SAME receipt for another token', async () => {
    // The receipt of a batch can carry a guard log about a coin this request
    // knows nothing about. Reading it as ours would report the customer's money
    // as blocked when it was never sent.
    const other = recordedReceipt('moderato-blocked-other-token');
    const logs = [...(BLOCKED.logs as unknown[])].filter(
      (log) => (log as { topics: string[] }).topics[0] !== TRANSFER_BLOCKED_TOPIC,
    );
    // Spliced onto THIS receipt's transaction and block, or the receipt bound
    // throws them out before the token is ever compared - and then this row
    // would be the transaction-bound row above under another name.
    const spliced = (other.logs as Record<string, unknown>[]).map((log) => {
      const bound = {
        ...log,
        transactionHash: BLOCKED.transactionHash,
        blockNumber: BLOCKED.blockNumber,
      };
      return (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC
        ? withDataWord(bound, BLOCKED_MEMO_WORD, BLOCKED_MEMO.slice(2))
        : bound;
    });
    const receipt = { ...BLOCKED, logs: [...logs, ...spliced] };
    const chain = settledModerato({ receipts: { [BLOCKED_HASH]: receipt } });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: BLOCKED_HASH,
      fromBlock: BLOCKED_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it('ignores a guard log for the OTHER token', async () => {
    const other = recordedReceipt('moderato-blocked-other-token');
    const chain = moderato({
      logs: receiptLogs(other),
      timestamps: { 35_790_000: NOW + 60 + 600 + 1800 + 1 },
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).not.toBe('refused');
  });
});

describe('verifyTempoPayment - guards the fee leg and the ordering owe', () => {
  const memoLog = (SINGLE.logs as Record<string, unknown>[]).find(
    (log) => (log.topics as string[])[0] === TRANSFER_WITH_MEMO_TOPIC,
  ) as Record<string, unknown>;

  it('does not take another payment to the same treasury as this request fee leg', async () => {
    // The treasury is shared by every provider on the chain, so without the
    // memo any transfer to it at or above the fee would answer for ours.
    const topics = memoLog.topics as string[];
    const strangersFee = {
      ...memoLog,
      topics: [
        topics[0],
        topics[1],
        `0x${'0'.repeat(24)}${TREASURY.slice(2)}`,
        `0x${'99'.repeat(32)}`,
      ],
      logIndex: '0x9',
    };
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [SINGLE_HASH]: { ...SINGLE, logs: [memoLog, strangersFee] } },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({
        memo: SINGLE_MEMO,
        amount: '20000',
        fee_address: TREASURY,
        fee_amount: '10000',
      }),
      { txSignature: SINGLE_HASH, fromBlock: SINGLE_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });

  it('settles on the EARLIEST transaction when two carry one memo', async () => {
    // Two real transactions can share a (recipient, memo) pair - a customer who
    // double-sends produces exactly that - and which one settles the request
    // must not depend on the node's ordering or on which chunk failed.
    const later = `0x${'ab'.repeat(32)}`;
    const laterLog = { ...memoLog, transactionHash: later, blockNumber: '0x25d1e00' };
    const chain = chainWith({
      receipts: {
        [SINGLE_HASH]: SINGLE,
        [later]: { ...SINGLE, transactionHash: later, blockNumber: '0x25d1e00', logs: [laterLog] },
      },
      timestamps: { 40_000_000: NOW, [SINGLE_BLOCK]: NOW, 39_657_984: NOW },
      // The node lists the later one first.
      logs: [
        {
          address: USDCE,
          topics: laterLog.topics as string[],
          data: String(laterLog.data),
          blockNumber: 39_657_984,
          transactionHash: later,
          logIndex: 0,
        },
        ...receiptLogs(SINGLE),
      ],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome === 'verified' && result.providerLeg.transactionHash).toBe(SINGLE_HASH);
  });

  it('ignores a receipt log that claims a block the receipt is not in', async () => {
    const elsewhere = { ...memoLog, blockNumber: '0x25d1e00' };
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: { ...SINGLE, logs: [elsewhere] } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'no_provider_leg' });
  });

  it.each([
    ['a non-canonical success', '0x01', 'verified'],
    ['a non-canonical failure', '0x00', 'refused'],
  ])('reads %s status as a quantity, not as a string', async (_label, status, outcome) => {
    // Reading it as a raw string turns every payment on such an endpoint into a
    // terminal refusal - on the hash path AND on the memo path, which credits
    // only through this one.
    const chain = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: { ...SINGLE, status } },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe(outcome);
  });

  it('vouches for the HEAD edge of the fee-leg scan, not the floor twice', async () => {
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      // History at the FLOOR only, and a node that will not serve a window wide
      // enough for the head's control to reach back to it: vouching for the
      // floor twice would pass, vouching for the head cannot.
      logs: controlTraffic(BATCH_BLOCK - 150, BATCH_BLOCK - 151),
      onGetLogs: (call) => (call.toBlock - call.fromBlock >= 4_096 ? rangeCapError() : undefined),
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ amount: '20000', fee_address: TREASURY, fee_amount: '10000' }),
      { txSignature: BATCH_HASH, fromBlock: BATCH_BLOCK - 100 },
    );
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'control_failed' });
  });
});

describe('verifyTempoPayment - without a hash', () => {
  function chainWithPayment(options: FakeChainOptions = {}) {
    return chainWith({
      receipts: { [SINGLE_HASH]: SINGLE },
      logs: receiptLogs(SINGLE),
      ...options,
    });
  }

  it('finds the payment by memo alone', async () => {
    const chain = chainWithPayment();
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).toBe('verified');
  });

  it('credits a candidate found by an INCOMPLETE pass', async () => {
    // Incompleteness blocks "nothing was sent"; it never blocks a credit.
    const chain = chainWithPayment({
      onGetLogs: (_call, index) => (index === 1 ? new Error('the node fell over') : undefined),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).toBe('verified');
  });

  it('will not say NOT PAID while the payment window is still open', async () => {
    const chain = chainWith({ logs: [] });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
  });

  it('will not say NOT PAID inside the LATE grace, after the expiry has passed', async () => {
    // A payment that lands after its request expired is still the customer's
    // money, so the expiry alone is not the deadline.
    const chain = chainWith({
      timestamps: { 40_000_000: NOW - 60 + 600 + 60, [SINGLE_BLOCK]: NOW },
      logs: [],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
  });

  it('refuses to say NOT PAID when only the FLOOR edge is vouched for', async () => {
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      logs: controlTraffic(SINGLE_BLOCK - 150, SINGLE_BLOCK - 151),
      onGetLogs: (call) => (call.toBlock - call.fromBlock >= 4_096 ? rangeCapError() : undefined),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'control_failed' });
  });

  it('refuses to say NOT PAID when only the HEAD edge of the scan is vouched for', async () => {
    // The floor is where a pruning node stops holding logs, so the edge that
    // matters most is the one an endpoint is most likely to have dropped.
    const chain = chainWith({
      timestamps: { 40_000_000: NOW + 60 + 600 + 1800 + 1 },
      logs: [
        {
          address: USDCE,
          topics: [`0x${'55'.repeat(32)}`],
          data: '0x',
          blockNumber: 39_999_900,
          transactionHash: `0x${'33'.repeat(32)}`,
          logIndex: 0,
        },
      ],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'control_failed' });
  });

  it('will not say NOT PAID after an INCOMPLETE pass that found nothing', async () => {
    const chain = chainWith({
      timestamps: { 40_000_000: NOW + 60 + 600 + 1800 + 1 },
      logs: [],
      onGetLogs: (call) =>
        call.address.toLowerCase() === USDCE ? new Error('the node fell over') : undefined,
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'incomplete_scan' });
  });

  it('will not say NOT PAID while the guard lookup itself was incomplete', async () => {
    // The third precondition of `none`: a blocked transfer is not a transfer
    // that never happened, and a lookup that could not finish has not shown it.
    const chain = chainWith({
      timestamps: { 40_000_000: PAST_DEADLINE },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900),
      onGetLogs: (call) =>
        call.address.toLowerCase() === TEMPO_TRANSFER_GUARD
          ? new Error('the node fell over')
          : undefined,
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'incomplete_scan' });
  });

  it('waits out the deadline SECOND, never at the instant it falls due', async () => {
    const chain = chainWith({
      // Exactly the deadline, not past it.
      timestamps: { 40_000_000: NOW - 60 + 600 + 1800 },
      logs: controlTraffic(SINGLE_BLOCK - 150, 39_999_900),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
  });

  it('says NOT PAID once the window closed, the pass was complete and history checks out', async () => {
    const chain = chainWith({
      timestamps: { 40_000_000: NOW + 60 + 600 + 1800 + 1 },
      // Other traffic on the same token, which is what vouches for the endpoint.
      logs: [
        {
          address: USDCE,
          topics: [`0x${'55'.repeat(32)}`],
          data: '0x',
          blockNumber: SINGLE_BLOCK - 150,
          transactionHash: `0x${'22'.repeat(32)}`,
          logIndex: 0,
        },
        {
          address: USDCE,
          topics: [`0x${'55'.repeat(32)}`],
          data: '0x',
          blockNumber: 39_999_900,
          transactionHash: `0x${'33'.repeat(32)}`,
          logIndex: 0,
        },
      ],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'none' });
  });

  it('refuses to say NOT PAID when the endpoint cannot show the token has history', async () => {
    // A node with pruned logs answers an empty list with no error, and that is
    // exactly what "nobody paid" looks like.
    const chain = chainWith({
      timestamps: { 40_000_000: NOW + 60 + 600 + 1800 + 1 },
      logs: [],
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'control_failed' });
  });

  it('polls until its budget runs out and then reports what it last saw', async () => {
    const chain = chainWith({ logs: [] });
    const started = Date.now();
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 60,
      pollIntervalMs: 10,
    });
    expect(result.outcome).toBe('inconclusive');
    expect(Date.now() - started).toBeLessThan(2_000);
    // Counted by PASSES, not by chunk requests: one pass already issues several
    // of those, so a loop that never looped would satisfy that count.
    const passes = chain.calls.filter(
      (call) => call.method === 'eth_getBlockByNumber' && call.params?.[0] === 'finalized',
    ).length;
    expect(passes).toBeGreaterThan(1);
  });

  it('does one pass and stops when the caller asked for no budget', async () => {
    const chain = chainWith({ logs: [] });
    await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    const passes = chain.calls.filter(
      (call) => call.method === 'eth_getBlockByNumber' && call.params?.[0] === 'finalized',
    ).length;
    expect(passes).toBe(1);
  });

  it('gives up polling at once when the caller aborts', async () => {
    const chain = chainWith({ logs: [] });
    const controller = new AbortController();
    const started = Date.now();
    const pending = verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 5_000,
      pollIntervalMs: 2_000,
      signal: controller.signal,
    });
    controller.abort();
    expect((await pending).outcome).toBe('inconclusive');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

function wire(log: FakeLog): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: `0x${log.blockNumber.toString(16)}`,
    transactionHash: log.transactionHash,
    logIndex: `0x${log.logIndex.toString(16)}`,
    removed: false,
  };
}

describe('readTempoReceivePolicy', () => {
  it('reads the policy at the FINALIZED tag, not one a reorg could take back', async () => {
    // A lagging backend resolving `latest` to a stale "open" would have the
    // provider quote a price the chain will block.
    const asked: string[] = [];
    const chain = fakeTempoChain({ chainId: '0xa5bf' });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_call') {
          asked.push(String(args.params?.[1]));
          return `0x${'0'.repeat(64 * 6)}`;
        }
        return chain.client.request(args);
      },
    };
    await readTempoReceivePolicy(client, RECIPIENT);
    expect(asked).toEqual(['finalized']);
  });

  it('refuses an address that is not one, rather than asking about nonsense', async () => {
    const chain = fakeTempoChain({ chainId: '0xa5bf' });
    await expect(readTempoReceivePolicy(chain.client, 'the-provider')).rejects.toThrow(
      /Not an address a receive policy can be read for/,
    );
  });
});

describe('createTempoPaymentRequest', () => {
  const MODERATO = CHAINS.TEMPO_DEVNET;
  const asset = PATHUSD_TEMPO;
  const OPEN_POLICY = `0x${'0'.repeat(64 * 6)}`;
  const CLOSED_POLICY = `0x${'1'.padStart(64, '0')}${'0'.repeat(64 * 5)}`;

  /** A CONFIGURED policy: `(set, senderId, senderType, tokenId, tokenType, recovery)`. */
  function configuredPolicy(
    senderPolicyId: number,
    tokenFilterId: number,
    senderPolicyType = 1,
    tokenFilterType = 1,
  ): string {
    const word = (value: number) => value.toString(16).padStart(64, '0');
    return `0x${word(1)}${word(senderPolicyId)}${word(senderPolicyType)}${word(tokenFilterId)}${word(tokenFilterType)}${word(0)}`;
  }

  function issuer(options: { fee?: number; policy?: (address: string) => string } = {}) {
    const feeWord = BigInt(options.fee ?? 0)
      .toString(16)
      .padStart(64, '0');
    return fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 36_200_000,
      timestamps: { 36_200_000: NOW },
      onCall: (to, data) => {
        if (to.toLowerCase() === MODERATO.protocolConfig.address) {
          return `0x${feeWord}${'0'.repeat(24)}${TREASURY.slice(2)}`;
        }
        if (to.toLowerCase() === TEMPO_POLICY_REGISTRY) {
          return options.policy?.(`0x${data.slice(-40)}`) ?? OPEN_POLICY;
        }
        return '0x';
      },
    });
  }

  it('issues a request its own parser accepts, with a random memo and a floor', async () => {
    const chain = issuer();
    const first = await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    expect(first.request.chain).toBe('eip155:42431');
    expect(first.request.asset).toBe(`eip155:42431/erc20:${PATHUSD}`);
    expect(first.request.amount).toBe('1000000');
    expect(first.request.fee_address).toBeUndefined();
    expect(first.fromBlock).toBe(36_200_000);
    const second = await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    // The memo is what binds a transfer to THIS request. Two requests for the
    // same price to the same address must never share one.
    expect(second.request.memo).not.toBe(first.request.memo);
  });

  it('carries the fee legs when the chain says there is a fee', async () => {
    const chain = issuer({ fee: 250 });
    const { request } = await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    expect(request.fee_address).toBe(TREASURY);
    expect(request.fee_amount).toBe('25000');
  });

  it('refuses to quote a recipient whose receive policy would block the payment', async () => {
    const chain = issuer({
      policy: (address) => (address === RECIPIENT ? CLOSED_POLICY : OPEN_POLICY),
    });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/does not accept incoming transfers/);
  });

  it.each([
    ['a sender list that lets us in, and a token filter that does not', 1, 7, 1, 1],
    ['a token filter that lets this coin in, and a sender list that does not', 7, 1, 1, 1],
    ['neither filter open', 7, 9, 1, 1],
    // Read live: a custom list answers its id with a TYPE of 0, and the ids
    // are a per-chain counter - so list number one wears the same id as the
    // built-in allow-all and means the opposite.
    ['the allow-all id under a custom-LIST type, on the sender axis', 1, 1, 0, 1],
    ['the same on the token axis', 1, 1, 1, 0],
  ])(
    'refuses to quote a policy that is open on one axis only: %s',
    async (_label, senderPolicyId, tokenFilterId, senderPolicyType, tokenFilterType) => {
      // A recipient is only safe to quote when BOTH filters are allow-all. The
      // realistic policy is the first row - a receiver that takes anyone's
      // money but not this coin - and reading it as open quotes a price whose
      // payment the guard will park out of reach of both sides.
      const chain = issuer({
        policy: (address) =>
          address === RECIPIENT
            ? configuredPolicy(senderPolicyId, tokenFilterId, senderPolicyType, tokenFilterType)
            : OPEN_POLICY,
      });
      await expect(
        createTempoPaymentRequest(chain.client, MODERATO, {
          recipient: RECIPIENT,
          amount: 1_000_000n,
          asset,
        }),
      ).rejects.toThrow(/does not accept incoming transfers/);
    },
  );

  it('quotes a CONFIGURED policy whose filters are both allow-all', async () => {
    // The mirror of the rows above: `open` has to stay reachable with a policy
    // that exists, or every configured receiver would be unquotable.
    const chain = issuer({ policy: () => configuredPolicy(1, 1) });
    const { request } = await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    expect(request.recipient).toBe(RECIPIENT);
  });

  it('refuses to quote when the TREASURY would block the fee leg', async () => {
    const chain = issuer({
      fee: 250,
      policy: (address) => (address === TREASURY ? CLOSED_POLICY : OPEN_POLICY),
    });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/treasury .* does not accept incoming transfers/);
  });

  it.each([
    ['nothing at all - what an address with no code answers', '0x'],
    // Zero is the ACCEPTING value of the first word, so a short answer must
    // never be allowed to decode as one.
    ['one word of zeros', `0x${'0'.repeat(64)}`],
    ['five words', `0x${'0'.repeat(64 * 5)}`],
    ['seven words', `0x${'0'.repeat(64 * 7)}`],
    [
      'a first word that is not a flag',
      `0x${'2'.padStart(64, '0')}${`0x${'1'.padStart(64, '0')}`.slice(2)}${'0'.repeat(64)}${'1'.padStart(64, '0')}${'0'.repeat(64 * 2)}`,
    ],
  ])(
    'refuses a policy read that answers %s - an unreadable policy is not "open"',
    async (_label, answer) => {
      const chain = issuer({ policy: () => answer });
      await expect(
        createTempoPaymentRequest(chain.client, MODERATO, {
          recipient: RECIPIENT,
          amount: 1_000_000n,
          asset,
        }),
      ).rejects.toThrow(/Could not read the receive policy/);
    },
  );

  it('refuses when the finalized block cannot be read: there would be no floor', async () => {
    const chain = fakeTempoChain({ chainId: '0xa5bf', finalized: null });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/Could not read the finalized block/);
  });

  it('refuses an endpoint that is not this chain', async () => {
    const chain = fakeTempoChain({ chainId: '0x1079' });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/is not chain 42431/);
  });

  it.each([
    // TIP-1022: bytes 4..14 are ten 0xfd. A transfer to one is forwarded to a
    // master account and bypasses every receive-policy read.
    ['a virtual address', `0x11223344${'fd'.repeat(10)}556677889900`],
    ['something that is not an address', 'the-provider'],
  ])('refuses to quote to %s', async (_label, recipient) => {
    const chain = issuer();
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, { recipient, amount: 1_000n, asset }),
    ).rejects.toThrow(/Not an address a payment can be issued to/);
  });

  it.each([
    ['a Solana coin', ALL_ASSETS.find((candidate) => candidate.chain === 'solana')],
    ['a Tempo coin that does not exist on THIS network', USDCE_TEMPO_MAINNET],
  ])('refuses %s before touching the chain at all', async (_label, wrongAsset) => {
    const chain = issuer();
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000n,
        asset: wrongAsset,
      }),
    ).rejects.toThrow(/is not a coin of/);
    // Checked from the registry, so a wrong coin costs no rpc and no time.
    expect(chain.calls).toEqual([]);
  });

  it('refuses an amount too small to carry the fee it would owe', async () => {
    // At the contract's own cap, one subunit rounds a whole subunit of fee -
    // and a provider leg of nothing is not a payment.
    const chain = issuer({ fee: 1_000 });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1n,
        asset,
      }),
    ).rejects.toThrow(/too small to carry/);
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
  ])('refuses %s as an amount', async (_label, amount) => {
    const chain = issuer();
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, { recipient: RECIPIENT, amount, asset }),
    ).rejects.toThrow(/positive amount/);
  });

  it.each([
    ['zero', 0],
    ['longer than a day', 86_401],
    ['not an integer', 1.5],
  ])('refuses an expiry that is %s', async (_label, expirySecs) => {
    const chain = issuer();
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000n,
        asset,
        expirySecs,
      }),
    ).rejects.toThrow(/Invalid expiry/);
  });

  it('issues nothing when the config contract cannot be read', async () => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 36_200_000,
      timestamps: { 36_200_000: NOW },
      onCall: () => '0x',
    });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000n,
        asset,
      }),
    ).rejects.toThrow(/Refusing the elisym config|Failed to read/);
  });
});
