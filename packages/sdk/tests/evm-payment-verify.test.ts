/**
 * Issuing a Tempo payment request, and deciding whether it was paid.
 *
 * The verify rows run over RECORDED mainnet and Moderato receipts, mutated
 * minimally, through a client that evaluates the `eth_getLogs` filter rather
 * than answering a blanket list. What each row must come out as is listed in
 * the facts file beside the plan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEvmProtocolConfigCache } from '../src/evm/config';
import {
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from '../src/evm/constants';
import { MAX_ISSUER_CLOCK_SKEW_SECS } from '../src/evm/constants';
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
    ...options,
    // Merged, never replaced: a receipt is bound to the block it names, and a
    // real node always has that block. A row overriding the head's clock must
    // not accidentally take the receipt's own block away with it. The same
    // goes for every block a LOG sits in, now that a log is bound to its block
    // too - a node that serves the log and not its block does not exist, and a
    // row that wants one says so by naming the block `undefined`.
    timestamps: {
      40_000_000: NOW,
      [BATCH_BLOCK]: NOW,
      [SINGLE_BLOCK]: NOW,
      ...Object.fromEntries((options.logs ?? []).map((log) => [log.blockNumber, NOW])),
      ...options.timestamps,
    },
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

  it.each([
    ['none', {}],
    ['a refusal that rested on reads', { [SINGLE_HASH]: { ...SINGLE, status: '0x0' } }],
  ])('asks the chain again before answering %s', async (label, receipts) => {
    // The gate runs once and a verify makes five to a hundred calls after it.
    // An endpoint free to move between them - a gateway failing over, a wallet
    // switching network - would otherwise answer TERMINALLY about money
    // sitting on the chain the request names. Measured live at 45 seconds.
    let answered = 0;
    const base = settledChain(SINGLE_BLOCK - 100, { receipts });
    const drifting = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId') {
          answered += 1;
          return answered === 1 ? '0x1079' : '0xa5bf';
        }
        return base.client.request(args);
      },
    };
    const result = await verifyTempoPayment(drifting, requestOf({ memo: SINGLE_MEMO }), {
      ...(label === 'none' ? {} : { txSignature: SINGLE_HASH }),
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
    expect(answered).toBe(2);
  });

  it('does NOT pay for a second chain read when the answer is not terminal', async () => {
    // An unknown is not an answer, so it buys nothing. A credit does: it is
    // the one verdict that hands over the provider's work, and a whole
    // endpoint on the other network would otherwise verify a free testnet
    // transfer carrying this request's memo.
    const unknown = chainWith({ receipts: {}, logs: [] });
    const waiting = await verifyTempoPayment(unknown.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(waiting.outcome).toBe('inconclusive');
    expect(unknown.calls.filter((call) => call.method === 'eth_chainId')).toHaveLength(1);

    const credited = chainWith({ receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(credited.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result.outcome).toBe('verified');
    expect(credited.calls.filter((call) => call.method === 'eth_chainId')).toHaveLength(2);
  });

  it('keeps a complete look when the last chain read cannot answer', async () => {
    // The closing confirmation asks whether the endpoint MOVED. An endpoint
    // that will not say which chain it is has not moved - and throwing away a
    // complete look because the last of twenty calls was rate-limited costs
    // the job for nothing.
    let answered = 0;
    const base = settledChain(SINGLE_BLOCK - 100, { receipts: {} });
    const quiet = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId') {
          answered += 1;
          return answered === 1 ? '0x1079' : null;
        }
        return base.client.request(args);
      },
    };
    const result = await verifyTempoPayment(quiet, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'none' });
    expect(answered).toBe(2);
  });

  it('credits nothing from a receipt whose BLOCK this chain does not have', async () => {
    // The receipt is the only thing here that arrives whole from one call, and
    // every other check reads it against itself. A gateway that answers
    // `eth_chainId` for one network and `eth_getTransactionReceipt` for
    // another would otherwise credit a transfer of free testnet coin - the
    // token address is the same on both - carrying this request's memo, which
    // the customer has and the customer chooses which hash to report.
    const chain = chainWith({
      receipts: { [SINGLE_HASH]: SINGLE },
      blockHashes: { [SINGLE_BLOCK]: `0x${'7c'.repeat(32)}` },
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
  });

  it('credits nothing from a receipt that names no block at all', async () => {
    const { blockHash: _dropped, ...noBlockHash } = SINGLE as Record<string, unknown>;
    const chain = chainWith({ receipts: { [SINGLE_HASH]: noBlockHash } });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
  });

  it('says nothing about a payment when the ENDPOINT is another chain', async () => {
    // An operator repoints `EVM_RPC_URL`, or a multi-chain gateway fails over
    // for one call. That is a fact about the endpoint, and refusing every
    // in-flight job on it is the same mistake as reading a broken receipt as
    // evidence - the money is on the chain the request names, untouched.
    const chain = chainWith({ chainId: '0xa5bf', receipts: { [SINGLE_HASH]: SINGLE } });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: SINGLE_HASH,
      fromBlock: SINGLE_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
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
      pollBudgetMs: 0,
    });
    // Which unknown it is depends on how far the second look got; that it is
    // an unknown, and never `none`, is the rule.
    expect(result.outcome).toBe('inconclusive');
  });

  it('does not let one bad receipt read unmake a leg the SCAN decoded', async () => {
    // The scan DECODED this leg: the registry token, our recipient, our memo,
    // at or above the price, in a finalized block. A receipt read that then
    // cannot see it is a failed READ and nothing else - a reverted transaction
    // emits no logs and a finalized log cannot vanish - so it is an unknown,
    // never a terminal refusal of money that is on chain.
    const chain = chainWith({
      receipts: { [SINGLE_HASH]: { ...SINGLE, status: 1 } },
      logs: receiptLogs(SINGLE),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'no_receipt' });
  });

  it('and credits it on the next pass once the endpoint answers properly', async () => {
    let reads = 0;
    const chain = chainWith({ receipts: { [SINGLE_HASH]: SINGLE }, logs: receiptLogs(SINGLE) });
    const flaky = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_getTransactionReceipt') {
          reads += 1;
          if (reads === 1) {
            return { ...SINGLE, status: 1 };
          }
        }
        return chain.client.request(args);
      },
    };
    const result = await verifyTempoPayment(flaky, requestOf({ memo: SINGLE_MEMO }), {
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 400,
      pollIntervalMs: 10,
    });
    expect(result.outcome).toBe('verified');
  });

  it('keeps its poll budget when the system clock steps BACKWARD', async () => {
    // The bound exists so one unpaid job cannot pin a provider slot. A wall
    // clock that steps back - an NTP correction, a VM resume - would extend it
    // by the size of the step; the budget is a duration and is measured on a
    // clock that only moves forward.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow - 3_600_000);
    try {
      const chain = chainWith({ receipts: {}, logs: [] });
      const started = performance.now();
      const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
        fromBlock: SINGLE_BLOCK - 100,
        pollBudgetMs: 60,
        pollIntervalMs: 10,
      });
      expect(result.outcome).toBe('inconclusive');
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      clock.mockRestore();
    }
  });

  it('an unknown hash does not outrank a complete look that found nothing', async () => {
    // The scan looked over every block the payment could be in, on an endpoint
    // that proved it holds the history, past the deadline - that is `none`,
    // and "I have never seen that hash" must not soften it into "ask again".
    const bundleId = `0x${'6e'.repeat(32)}`;
    const chain = settledChain(SINGLE_BLOCK - 100, { receipts: {} });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: bundleId,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'none' });
  });

  it('finds the payment when the customer reports a BUNDLE ID instead of a hash', async () => {
    // A user-operation hash and a bundle id are both 32 bytes and both answer
    // `null` here. Without the second look, reporting one is strictly worse
    // than reporting nothing at all: the same chain, asked with no hash,
    // verifies.
    const bundleId = `0x${'6d'.repeat(32)}`;
    const chain = chainWith({
      receipts: { [SINGLE_HASH]: SINGLE },
      logs: receiptLogs(SINGLE),
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: bundleId,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).toBe('verified');
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
    // pair spread over 32. The earlier one paid the provider and not the fee,
    // which is a refusal that stands on its own; the later one cannot be read
    // right now. The unknown has to win, or the job dies while the money is
    // still readable.
    const later = `0x${'6b'.repeat(32)}`;
    const providerLogs = receiptLogs(BATCH).filter((log) =>
      log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = settledChain(BATCH_BLOCK - 100, {
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: [
        ...providerLogs,
        ...providerLogs.map((log) => ({
          ...log,
          transactionHash: later,
          blockNumber: log.blockNumber + 1,
        })),
      ],
    });
    const result = await verifyTempoPayment(
      chain.client,
      requestOf({ amount: '20000', fee_address: TREASURY, fee_amount: '10000' }),
      { fromBlock: BATCH_BLOCK - 100, pollBudgetMs: 0 },
    );
    expect(result.outcome).toBe('inconclusive');
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

  it.each([
    ['WAITS while the window is open', NOW, { outcome: 'inconclusive', reason: 'not_yet_due' }],
    [
      'keeps the blocked verdict once it has closed',
      PAST_DEADLINE,
      { outcome: 'refused', code: 'provider_leg_blocked' },
    ],
  ])('when the second look finds only the bounce, it %s', async (_label, clock, expected) => {
    // A bounced transfer means the customer's money LEFT and parked with the
    // guard - which is a reason to wait, not to stop. The receiver opens its
    // policy (this verdict is what tells the provider to ask), the customer
    // sends again, and the retry lands inside the same window. Refusing on the
    // first bounce closes the job minutes before the money arrives.
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: clock, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
      logs: [...controlTraffic(BLOCKED_BLOCK - 150, 35_789_900, PATHUSD), ...receiptLogs(BLOCKED)],
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
      { txSignature: BLOCKED_HASH, fromBlock: BLOCKED_BLOCK - 100, pollBudgetMs: 0 },
    );
    expect(result).toEqual(expected);
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

  /** The recorded batch, split: the provider leg here, the fee leg over there. */
  function splitBatch(feeHash: string) {
    const logs = receiptLogs(BATCH);
    return {
      providerLogs: logs.filter((log) => log.topics[2]?.endsWith(RECIPIENT.slice(2))),
      feeLogs: logs
        .filter((log) => log.topics[2]?.endsWith(TREASURY.slice(2)))
        .map((log) => ({ ...log, transactionHash: feeHash })),
    };
  }

  /** The guard's `TransferBlocked`, re-pointed at OUR token, treasury and memo. */
  function bouncedFeeLeg(transactionHash: string, blockNumber: number): FakeLog[] {
    const word = (value: string) => `${'0'.repeat(24)}${value.slice(2)}`;
    return receiptLogs(BLOCKED)
      .filter((log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC)
      .map((log) => {
        const body = log.data;
        const withToken = `${body.slice(0, 2 + 5 * 64)}${word(USDCE)}${body.slice(2 + 6 * 64)}`;
        const withRecipient = `${withToken.slice(0, 2 + 8 * 64)}${word(TREASURY)}${withToken.slice(2 + 9 * 64)}`;
        const withMemo = `${withRecipient.slice(0, 2 + 13 * 64)}${BATCH_MEMO.slice(2)}${withRecipient.slice(2 + 14 * 64)}`;
        return {
          ...log,
          topics: [log.topics[0], `0x${word(USDCE)}`, `0x${word(TREASURY)}`, log.topics[3]],
          data: withMemo,
          transactionHash,
          blockNumber,
        } as FakeLog;
      });
  }

  it('credits a fee leg this transaction BOUNCED and another one paid', async () => {
    // The receipt carries a real guard log for the fee leg, and the fee was
    // then paid by a second transaction. Asking the guard before looking is
    // how a fully paid job became a terminal refusal - with the provider's own
    // leg already in the provider's account, and with NO hash reported either.
    const feeHash = `0x${'fe'.repeat(32)}`;
    const { providerLogs, feeLogs } = splitBatch(feeHash);
    const bounced = bouncedFeeLeg(BATCH_HASH, BATCH_BLOCK);
    const chain = chainWith({
      receipts: {
        [BATCH_HASH]: { ...BATCH, logs: [...providerLogs.map(wire), ...bounced.map(wire)] },
        [feeHash]: { ...BATCH, transactionHash: feeHash, logs: feeLogs.map(wire) },
      },
      logs: [...providerLogs, ...feeLogs, ...bounced],
    });
    for (const txSignature of [BATCH_HASH, undefined]) {
      const result = await verifyTempoPayment(chain.client, feeRequest, {
        ...(txSignature === undefined ? {} : { txSignature }),
        fromBlock: BATCH_BLOCK - 100,
        pollBudgetMs: 0,
      });
      expect(result.outcome).toBe('verified');
    }
  });

  it('says the fee leg was BLOCKED when nothing else paid it', async () => {
    // The other half of the same rule: once the look has happened and found
    // nothing, the guard log in this receipt says where the money went.
    const bounced = bouncedFeeLeg(BATCH_HASH, BATCH_BLOCK);
    const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
    // The guard log is in the RECEIPT only - if it were in the log store too,
    // the range scan would reach `fee_leg_blocked` on its own and this row
    // would not be about the receipt at all.
    const chain = settledChain(BATCH_BLOCK - 100, {
      receipts: {
        [BATCH_HASH]: { ...BATCH, logs: [...providerLogs.map(wire), ...bounced.map(wire)] },
      },
      logs: providerLogs,
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_blocked' });
  });

  it.each([
    [
      'the look could not finish',
      {
        onGetLogs: (call: { topics: (string | null)[] }) =>
          call.topics[0] === TRANSFER_WITH_MEMO_TOPIC && call.topics[2]?.endsWith(TREASURY.slice(2))
            ? new Error('the node fell over')
            : undefined,
      },
      { outcome: 'inconclusive', reason: 'incomplete_scan' },
    ],
    ['the window is still open', {}, { outcome: 'inconclusive', reason: 'not_yet_due' }],
  ])(
    'does not let the receipt’s guard log REACH a refusal when %s',
    async (_label, options, expected) => {
      // The rename gate has to be as strong as its name: a guard log may turn
      // a refusal the scan reached into a more specific one, and may not turn
      // an unknown into a refusal at all. One node fault would otherwise be
      // round 6's defect again.
      const bounced = bouncedFeeLeg(BATCH_HASH, BATCH_BLOCK);
      const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
      const chain = chainWith({
        receipts: {
          [BATCH_HASH]: { ...BATCH, logs: [...providerLogs.map(wire), ...bounced.map(wire)] },
        },
        logs: providerLogs,
        ...options,
      });
      const result = await verifyTempoPayment(chain.client, feeRequest, {
        txSignature: BATCH_HASH,
        fromBlock: BATCH_BLOCK - 100,
      });
      expect(result).toEqual(expected);
    },
  );

  it.each([
    ['in the log store, as a real one is', true],
    ['in the receipt alone', false],
  ])(
    'WAITS on a bounced fee leg while the window is open, with the guard log %s',
    async (_label, inTheStore) => {
      // Round 7's own scenario: the provider leg is paid, the fee leg is bounced
      // by the treasury's policy, and the customer can still send it again. The
      // deadline has to gate the blocked verdict from BOTH lookups, or the
      // range one reaches a terminal refusal before the retry can land.
      const bounced = bouncedFeeLeg(BATCH_HASH, BATCH_BLOCK);
      const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
      const chain = chainWith({
        receipts: {
          [BATCH_HASH]: { ...BATCH, logs: [...providerLogs.map(wire), ...bounced.map(wire)] },
        },
        logs: inTheStore ? [...providerLogs, ...bounced] : providerLogs,
      });
      const result = await verifyTempoPayment(chain.client, feeRequest, {
        txSignature: BATCH_HASH,
        fromBlock: BATCH_BLOCK - 100,
      });
      expect(result).toEqual({ outcome: 'inconclusive', reason: 'not_yet_due' });
    },
  );

  it('says the fee leg was BLOCKED from a guard log found by the RANGE scan', async () => {
    // The guard log is not in the named receipt at all - a second transaction
    // tried to pay the fee and the treasury bounced it.
    const bouncedHash = `0x${'bb'.repeat(32)}`;
    const bounced = bouncedFeeLeg(bouncedHash, BATCH_BLOCK + 1);
    const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
    const chain = settledChain(BATCH_BLOCK - 100, {
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: [...providerLogs, ...bounced],
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_blocked' });
  });

  it('does not read a guard log as a blocked PROVIDER leg the scan just found', async () => {
    // The scan decoded the provider leg in this transaction, and its receipt
    // comes back with a guard log instead - the two cannot both be true, so
    // the receipt is the one that is wrong. It is an unknown, like every other
    // way a receipt can contradict a decoded leg.
    const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
    const guardOnly = bouncedFeeLeg(BATCH_HASH, BATCH_BLOCK).map((log) => ({
      ...log,
      topics: [
        log.topics[0],
        log.topics[1],
        `0x${'0'.repeat(24)}${RECIPIENT.slice(2)}`,
        log.topics[3],
      ],
      data: `${log.data.slice(0, 2 + 8 * 64)}${'0'.repeat(24)}${RECIPIENT.slice(2)}${log.data.slice(2 + 9 * 64)}`,
    }));
    const chain = settledChain(BATCH_BLOCK - 100, {
      receipts: { [BATCH_HASH]: { ...BATCH, logs: guardOnly.map(wire) } },
      logs: providerLogs,
    });
    const result = await verifyTempoPayment(chain.client, requestOf({ memo: BATCH_MEMO }), {
      fromBlock: BATCH_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).toBe('inconclusive');
  });

  /** The finalized TAG answers; the same block asked for by NUMBER does not. */
  function headByNumberUnreadable(chain: { client: { request: (args: never) => unknown } }) {
    // Only the HEAD by number: the receipt's own block still reads, or the
    // receipt's chain bind would answer first and this row would be about it.
    const head = `0x${(40_000_000).toString(16)}`;
    return {
      request: async (args: { method: string; params?: readonly unknown[] }) =>
        args.method === 'eth_getBlockByNumber' && args.params?.[0] === head
          ? null
          : chain.client.request(args as never),
    };
  }

  it.each([
    ['the fee-leg lookup', true],
    ['the no-hash pass', false],
  ])('says nothing when the head block will not read, on %s', async (_label, withHash) => {
    // The deadline is read off a block. A node that serves `eth_getLogs` but
    // not `eth_getBlockByNumber` for its own head has answered NOTHING about
    // the payment, and both verdicts below it are terminal.
    const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
    const chain = chainWith({
      receipts: withHash ? { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } } : {},
      logs: withHash
        ? [...controlTraffic(BATCH_BLOCK - 150, 39_999_900), ...providerLogs]
        : controlTraffic(BATCH_BLOCK - 150, 39_999_900),
      timestamps: { 40_000_000: PAST_DEADLINE },
    });
    const result = await verifyTempoPayment(
      headByNumberUnreadable(chain),
      withHash ? feeRequest : requestOf({ memo: `0x${'ab'.repeat(32)}` }),
      {
        ...(withHash ? { txSignature: BATCH_HASH } : {}),
        fromBlock: BATCH_BLOCK - 100,
        pollBudgetMs: 0,
      },
    );
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
  });

  it('says the fee leg is MISSING with no hash at all, once the window has closed', async () => {
    // The commonest fee-path answer, and the one the no-hash path has to be
    // able to reach: the provider leg is on chain, the fee leg never came, and
    // the deadline has passed. It is terminal, not "ask again".
    const { providerLogs } = splitBatch(`0x${'fe'.repeat(32)}`);
    const chain = settledChain(BATCH_BLOCK - 100, {
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: providerLogs,
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      fromBlock: BATCH_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'fee_leg_missing' });
  });

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

  it('will not credit a fee leg whose BLOCK this chain does not have', async () => {
    // The provider leg goes through a receipt and, since round 10, through its
    // block. The fee leg is one `eth_getLogs` entry and it completes a
    // payment: a backend serving the other Tempo network answers the same
    // token at the same address, so the fee could be paid in free testnet coin.
    const logs = receiptLogs(BATCH);
    const providerLogs = logs.filter((log) => log.topics[2]?.endsWith(RECIPIENT.slice(2)));
    const feeLogs = logs.filter((log) => log.topics[2]?.endsWith(TREASURY.slice(2)));
    const feeHash = `0x${'fe'.repeat(32)}`;
    const chain = chainWith({
      receipts: { [BATCH_HASH]: { ...BATCH, logs: providerLogs.map(wire) } },
      logs: feeLogs.map((log) => ({
        ...log,
        transactionHash: feeHash,
        // The same height, a block this chain never had.
        blockHash: `0x${'9e'.repeat(32)}`,
      })),
    });
    const result = await verifyTempoPayment(chain.client, feeRequest, {
      txSignature: BATCH_HASH,
      fromBlock: BATCH_BLOCK - 100,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
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
      ...options,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW, ...options.timestamps },
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
    // customer's money is sitting with the guard. The receipt's logs are in
    // the chain's own log store too, because that is where a real one is.
    const chain = settledModerato({ receipts: { [BLOCKED_HASH]: BLOCKED } });
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

  it('says BLOCKED by hash even when the second look cannot run', async () => {
    // The guard log in the named receipt is evidence on its own. A second look
    // that comes back unknown may defer it; one that comes back empty may not
    // erase it.
    const chain = settledModerato({ receipts: { [BLOCKED_HASH]: BLOCKED } });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: BLOCKED_HASH,
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'provider_leg_blocked' });
  });

  it('looks past a guard log in ANOTHER transaction to the payment that landed', async () => {
    // One transaction was bounced by the receiver's policy and a second paid.
    // The customer reports the first. That receipt says nothing about the
    // second, and the money is in the provider's account.
    const bounced = `0x${'5c'.repeat(32)}`;
    const landed = `0x${'5d'.repeat(32)}`;
    // A blocked transfer emits NO memo log - that is the whole difficulty -
    // so the second transaction's log is built, not taken from the fixture.
    const paidLog: FakeLog = {
      address: PATHUSD,
      topics: [
        TRANSFER_WITH_MEMO_TOPIC,
        `0x${'0'.repeat(24)}90f79bf6eb2c4f870365e785982e1f101e93b906`,
        `0x${'0'.repeat(24)}${BLOCKED_RECEIVER.slice(2)}`,
        BLOCKED_MEMO,
      ],
      data: `0x${(25_000_000).toString(16).padStart(64, '0')}`,
      blockNumber: BLOCKED_BLOCK,
      transactionHash: landed,
      logIndex: 0,
    };
    const chain = settledModerato({
      receipts: {
        [bounced]: {
          ...BLOCKED,
          transactionHash: bounced,
          logs: (BLOCKED.logs as Record<string, unknown>[]).map((log) => ({
            ...log,
            transactionHash: bounced,
          })),
        },
        [landed]: {
          ...BLOCKED,
          transactionHash: landed,
          status: '0x1',
          logs: [wire(paidLog)],
        },
      },
      logs: [paidLog],
    });
    const result = await verifyTempoPayment(chain.client, blockedRequest(), {
      txSignature: bounced,
      fromBlock: BLOCKED_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result.outcome).toBe('verified');
  });

  it('reads a blocked PROVIDER leg against the price less the fee', async () => {
    // With a fee, the provider's own leg is smaller than the request's amount.
    // Comparing the guard log against the full amount would answer `none` -
    // "nothing was ever sent" - on money sitting with the guard.
    const withFee = PaymentRequestV2Schema.parse({
      v: 2,
      chain: 'eip155:42431',
      asset: `eip155:42431/erc20:${PATHUSD}`,
      recipient: BLOCKED_RECEIVER,
      amount: '30000000',
      fee_address: TREASURY,
      fee_amount: '5000000',
      memo: BLOCKED_MEMO,
      created_at: NOW - 60,
      expiry_secs: 600,
    });
    // Through the RANGE lookup, with no hash: that is where the amount the
    // guard log must cover is chosen, and the receipt path compares its own.
    const chain = settledModerato({
      receipts: {},
      logs: receiptLogs(BLOCKED),
    });
    const result = await verifyTempoPayment(chain.client, withFee, {
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

  it('confirms the chain before crediting a payment found by MEMO after a bad hash', async () => {
    // Three exits can credit, and this is the one the CUSTOMER chooses: report
    // a hash the node has never seen and the verify falls through to the memo
    // scan. If that credit skips the closing chain ask, reporting a bundle id
    // becomes strictly BETTER than reporting nothing - the inversion of the
    // reason the second look exists at all.
    let answered = 0;
    const settled = settledChain(SINGLE_BLOCK - 100, {
      receipts: { [SINGLE_HASH]: SINGLE },
      logs: receiptLogs(SINGLE),
    });
    const moving = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId') {
          answered += 1;
          // Tempo mainnet first; by the second ask the endpoint is Moderato.
          return answered === 1 ? '0x1079' : '0xa5bf';
        }
        return settled.client.request(args);
      },
    };
    const result = await verifyTempoPayment(moving, requestOf({ memo: SINGLE_MEMO }), {
      txSignature: `0x${'aa'.repeat(32)}`,
      fromBlock: SINGLE_BLOCK - 100,
      pollBudgetMs: 0,
    });
    expect(result).toEqual({ outcome: 'inconclusive', reason: 'chain_unreadable' });
    expect(answered).toBe(2);
  });

  it('settles on the EARLIEST transaction when two carry one memo', async () => {
    // Two real transactions can share a (recipient, memo) pair - a customer who
    // double-sends produces exactly that - and which one settles the request
    // must not depend on the node's ordering or on which chunk failed.
    const later = `0x${'ab'.repeat(32)}`;
    // A block of its own, with a block hash of its own: a receipt that named
    // one block while its log sat in another would be refused by the chain
    // bind before the ordering was ever reached, and the row would pass for a
    // reason that has nothing to do with order.
    const laterBlock = SINGLE_BLOCK + 328;
    const laterLog = {
      ...memoLog,
      transactionHash: later,
      blockNumber: `0x${laterBlock.toString(16)}`,
    };
    const chain = chainWith({
      receipts: {
        [SINGLE_HASH]: SINGLE,
        [later]: {
          ...SINGLE,
          transactionHash: later,
          blockNumber: `0x${laterBlock.toString(16)}`,
          blockHash: `0x${'ef'.repeat(32)}`,
          logs: [laterLog],
        },
      },
      timestamps: { 40_000_000: NOW, [SINGLE_BLOCK]: NOW, [laterBlock]: NOW },
      // The node lists the later one first.
      logs: [
        {
          address: USDCE,
          topics: laterLog.topics as string[],
          data: String(laterLog.data),
          blockNumber: laterBlock,
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
    // Every log a node sends names its block, and the receipts built from
    // these are all copies of the recorded batch, so that is the block.
    blockHash: log.blockHash ?? String(BATCH.blockHash),
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

  it.each([
    [
      'a real one, whole',
      `0x${'1'.padStart(64, '0')}${(1_251_837).toString(16).padStart(64, '0')}${'0'.repeat(64)}${(1_251_838).toString(16).padStart(64, '0')}${'0'.repeat(64)}${'1'.padStart(64, '0')}`,
      {
        configured: true,
        senderPolicyId: 1_251_837n,
        senderPolicyType: 0n,
        tokenFilterId: 1_251_838n,
        tokenFilterType: 0n,
        recoveryAuthority: `0x${'0'.repeat(39)}1`,
      },
    ],
    ['seven words - not this contract', `0x${'0'.repeat(64 * 7)}`, null],
    ['a first word that is not a flag', `0x${'2'.padStart(64, '0')}${'0'.repeat(64 * 5)}`, null],
  ])('reads the six words of a policy: %s', async (_label, answer, expected) => {
    // The four filter words decide NOTHING - `canStrangerReceive` is what says
    // whether money can arrive - but they are still a fixed layout, and a
    // reader that accepts another one is reading another contract.
    const chain = fakeTempoChain({ chainId: '0xa5bf', onCall: () => answer });
    expect(await readTempoReceivePolicy(chain.client, RECIPIENT)).toEqual(expected);
  });
});

describe('createTempoPaymentRequest', () => {
  // The issuer compares the chain's clock against its own, so this fixture's
  // chain runs on real time rather than the fixed `NOW` the verifier rows use
  // - and five minutes behind it, so that "stamped from the chain" and
  // "stamped from the machine" are different numbers.
  const ISSUED_AT = Math.floor(Date.now() / 1000) - 300;
  const MODERATO = CHAINS.TEMPO_DEVNET;
  const asset = PATHUSD_TEMPO;
  const ACCEPTS = `0x${'1'.padStart(64, '0')}${'0'.repeat(64)}`;
  const REFUSES_THE_SENDER = `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`;

  /**
   * The registry, answering the question the issuer actually asks: may an
   * arbitrary sender pay THIS coin to THIS address. The probe sender is random
   * per call, so the fake keys on the token and the recipient and refuses to
   * answer anything else - an argument in the wrong slot would otherwise pass
   * unnoticed.
   */
  function issuer(options: { fee?: number; verdict?: (address: string) => string } = {}) {
    const feeWord = BigInt(options.fee ?? 0)
      .toString(16)
      .padStart(64, '0');
    return fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 36_200_000,
      timestamps: { 36_200_000: ISSUED_AT },
      onCall: (to, data) => {
        if (to.toLowerCase() === MODERATO.protocolConfig.address) {
          return `0x${feeWord}${'0'.repeat(24)}${TREASURY.slice(2)}`;
        }
        if (to.toLowerCase() !== TEMPO_POLICY_REGISTRY) {
          return '0x';
        }
        const words = data.slice(10).match(/.{64}/g) ?? [];
        const [token, , recipient] = words.map((word) => `0x${word.slice(24)}`);
        if (words.length !== 3 || token !== PATHUSD) {
          return REFUSES_THE_SENDER;
        }
        return options.verdict?.(String(recipient)) ?? ACCEPTS;
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

  it.each([
    ['behind', -MAX_ISSUER_CLOCK_SKEW_SECS - 1],
    ['ahead of', MAX_ISSUER_CLOCK_SKEW_SECS + 1],
  ])('refuses to quote when the endpoint clock is far %s this machine', async (_label, drift) => {
    // Stamping from the chain makes the window self-consistent under a
    // constant lag, and removes the only local anchor: an endpoint lagging by
    // more than the window mints requests already past their deadline, and one
    // answering a future timestamp mints requests no verdict can terminate.
    // Only the other clock can say the first one is implausible.
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 36_200_000,
      timestamps: { 36_200_000: Math.floor(Date.now() / 1000) + drift },
      onCall: () => `0x${'1'.padStart(64, '0')}${'0'.repeat(64)}`,
    });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/seconds from this machine's clock/);
  });

  it('stamps the request with the chain clock, not the machine it runs on', async () => {
    // Every deadline downstream is judged against a block timestamp, and the
    // issuer has already read one. A provider whose machine is behind chain
    // time by more than the window would issue requests born expired.
    const chain = issuer();
    const { request } = await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    expect(request.created_at).toBe(ISSUED_AT);
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
      verdict: (address) => (address === RECIPIENT ? REFUSES_THE_SENDER : ACCEPTS),
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
    ['the sender', `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`],
    ['this coin', `0x${'0'.repeat(64)}${'1'.padStart(64, '0')}`],
    // Zero is the ACCEPTING value of the second word, so a refusal that names
    // no reason at all is still a refusal.
    ['nothing it will say', `0x${'0'.repeat(64 * 2)}`],
    // `(1, 0)` and nothing else is a yes: an authorized flag with a reason
    // beside it contradicts itself, and is read the safe way round.
    ['with a reason beside a yes', `0x${'1'.padStart(64, '0')}${'3'.padStart(64, '0')}`],
  ])('refuses to quote a recipient whose policy refuses %s', async (_label, answer) => {
    const chain = issuer({ verdict: (address) => (address === RECIPIENT ? answer : ACCEPTS) });
    await expect(
      createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      }),
    ).rejects.toThrow(/does not accept incoming transfers/);
  });

  it('asks about the COIN being quoted, and at the finalized head', async () => {
    // The verdict is per (token, sender, receiver): asking about another coin
    // answers another question, and a policy a reorg could take back is not
    // one to quote against.
    const chain = issuer();
    await createTempoPaymentRequest(chain.client, MODERATO, {
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset,
    });
    const registryCalls = chain.calls.filter(
      (call) =>
        call.method === 'eth_call' &&
        (call.params?.[0] as { to?: string } | undefined)?.to?.toLowerCase() ===
          TEMPO_POLICY_REGISTRY,
    );
    expect(registryCalls).toHaveLength(1);
    const data = String((registryCalls[0]?.params?.[0] as { data?: string } | undefined)?.data);
    expect(data.slice(10, 74)).toBe(`${'0'.repeat(24)}${PATHUSD.slice(2)}`);
    expect(registryCalls[0]?.params?.[1]).toBe('finalized');
  });

  it('asks with a DIFFERENT sender each time, so no policy can allow the probe', async () => {
    // A fixed probe address could be allow-listed while every real customer is
    // refused, and the issuer would quote a price nobody can pay.
    const chain = issuer();
    for (let round = 0; round < 2; round += 1) {
      await createTempoPaymentRequest(chain.client, MODERATO, {
        recipient: RECIPIENT,
        amount: 1_000_000n,
        asset,
      });
    }
    const senders = chain.calls
      .filter(
        (call) =>
          call.method === 'eth_call' &&
          (call.params?.[0] as { to?: string } | undefined)?.to?.toLowerCase() ===
            TEMPO_POLICY_REGISTRY,
      )
      .map((call) =>
        String((call.params?.[0] as { data?: string } | undefined)?.data).slice(74, 138),
      );
    expect(senders).toHaveLength(2);
    expect(senders[0]).not.toBe(senders[1]);
  });

  it('refuses to quote when the TREASURY would block the fee leg', async () => {
    const chain = issuer({
      fee: 250,
      verdict: (address) => (address === TREASURY ? REFUSES_THE_SENDER : ACCEPTS),
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
    ['three words', `0x${'0'.repeat(64 * 3)}`],
  ])(
    'refuses a verdict that answers %s - an unreadable one is not "open"',
    async (_label, answer) => {
      const chain = issuer({ verdict: () => answer });
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
      timestamps: { 36_200_000: ISSUED_AT },
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
