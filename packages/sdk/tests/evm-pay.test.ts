/**
 * The customer's side of a Tempo payment: what must be true before money
 * moves, and what the sender may conclude about a transaction it sent.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPO_FEE_SINK,
  TEMPO_POLICY_REGISTRY,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from '../src/evm/constants';
import { resolveTempoTransferOutcome, type TempoLegExpectation } from '../src/evm/outcome';
import { checkTempoReceivePolicies, validateTempoPaymentRequest } from '../src/evm/validate';
import { PATHUSD_TEMPO, USDCE_TEMPO_MAINNET } from '../src/payment/assets';
import { CHAINS } from '../src/payment/chains';
import { fakeTempoChain, recordedReceipt, receiptLogs, type FakeChainOptions } from './tempo-chain';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const PAYER = '0x0ed8e782415d51eb7192cf0fce9914a5ed23bce1';
const RECIPIENT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const TREASURY = '0x7edb1404ebae28332867756c0d01440b9e63f3f7';
const MEMO = `0x${'7e'.repeat(32)}`;
const NOW = 1_700_000_000;

function requestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    chain: 'eip155:4217',
    asset: `eip155:4217/erc20:${USDCE}`,
    recipient: RECIPIENT,
    amount: '10000',
    memo: MEMO,
    created_at: NOW - 60,
    expiry_secs: 600,
    ...overrides,
  });
}

function bounds(overrides: Record<string, unknown> = {}) {
  return {
    chain: CHAINS.TEMPO_MAINNET,
    payer: PAYER,
    card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
    protocolFeeBps: 0,
    treasury: TREASURY,
    nowSecs: NOW,
    ...overrides,
  };
}

describe('validateTempoPaymentRequest', () => {
  it('accepts a request that matches the card and the chain’s fee', () => {
    expect(validateTempoPaymentRequest(requestJson(), bounds())).toBeNull();
  });

  it('accepts one that carries exactly the fee the chain charges', () => {
    const request = requestJson({ fee_address: TREASURY, fee_amount: '250' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 250 }))).toBeNull();
  });

  it.each([
    [
      'a v1 request',
      JSON.stringify({
        recipient: '11111111111111111111111111111111',
        amount: 1,
        reference: '11111111111111111111111111111112',
        created_at: NOW - 60,
        expiry_secs: 600,
      }),
      'unsupported_version',
    ],
    ['something that is not json', 'not json', 'invalid_json'],
  ])('refuses %s', (_label, blob, code) => {
    expect(validateTempoPaymentRequest(blob, bounds())?.code).toBe(code);
  });

  it('refuses a chain this SDK does not know', () => {
    const request = requestJson({ chain: 'eip155:999', asset: `eip155:999/erc20:${USDCE}` });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('unsupported_chain');
  });

  it('refuses a chain that is not the one this customer pays on, BEFORE any money check', () => {
    // A cross-chain request must never reach the fee arithmetic.
    const request = requestJson({
      chain: 'eip155:42431',
      asset: `eip155:42431/erc20:${PATHUSD}`,
      fee_address: `0x${'ab'.repeat(20)}`,
      fee_amount: '250',
    });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('chain_mismatch');
  });

  it('refuses a coin this SDK does not know', () => {
    const request = requestJson({ asset: `eip155:4217/erc20:0x${'11'.repeat(20)}` });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('invalid_asset');
  });

  it('refuses a coin that does not exist on THIS environment', () => {
    // USDC.e is a mainnet coin; on Moderato the same address is nothing.
    const request = requestJson({
      chain: 'eip155:42431',
      asset: `eip155:42431/erc20:${USDCE}`,
    });
    const problem = validateTempoPaymentRequest(
      request,
      bounds({
        chain: CHAINS.TEMPO_DEVNET,
        card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
      }),
    );
    expect(problem?.code).toBe('invalid_asset');
  });

  it('refuses a coin other than the one that was agreed', () => {
    const request = requestJson({ asset: `eip155:4217/erc20:${PATHUSD}` });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('asset_mismatch');
  });

  it('refuses a recipient the card never named', () => {
    const request = requestJson({ recipient: `0x${'cd'.repeat(20)}` });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('recipient_mismatch');
  });

  it.each([
    ['the recipient', { recipient: PAYER }],
    ['the fee address', { fee_address: PAYER, fee_amount: '250' }],
  ])('refuses a request that pays the customer’s own address as %s', (_label, overrides) => {
    // Such a leg has `from == to`, moves nothing and counts for nothing.
    const recipient = 'recipient' in overrides ? PAYER : RECIPIENT;
    const problem = validateTempoPaymentRequest(
      requestJson(overrides),
      bounds({
        protocolFeeBps: 250,
        card: { recipient, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
      }),
    );
    expect(problem?.code).toBe('self_payment');
  });

  it.each([
    ['not an address at all', 'the-customer'],
    ['a virtual address', `0x11223344${'fd'.repeat(10)}556677889900`],
  ])('refuses to pay from %s', (_label, payer) => {
    expect(validateTempoPaymentRequest(requestJson(), bounds({ payer }))?.code).toBe(
      'invalid_recipient_address',
    );
  });

  it('refuses a request dated in the future', () => {
    const request = requestJson({ created_at: NOW + 600 });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('future_timestamp');
  });

  it.each([
    ['already expired', NOW - 700],
    ['about to expire, with no time to pay', NOW - 540],
  ])('refuses a request that is %s', (_label, createdAt) => {
    const request = requestJson({ created_at: createdAt });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('expired');
  });

  it('says a request EXPIRED, not that it is short of time, once it has', () => {
    // Both refusals carry the `expired` code; only the message tells the
    // operator whether the customer had a window at all.
    const problem = validateTempoPaymentRequest(requestJson({ created_at: NOW - 700 }), bounds());
    expect(problem?.message).toMatch(/expired 100 seconds ago/);
  });

  it('refuses a fee leg when the chain says there is no fee', () => {
    const request = requestJson({ fee_address: TREASURY, fee_amount: '250' });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('invalid_fee_params');
  });

  it('refuses a missing fee leg when the chain charges one', () => {
    expect(validateTempoPaymentRequest(requestJson(), bounds({ protocolFeeBps: 250 }))?.code).toBe(
      'missing_fee',
    );
  });

  it('refuses a fee leg that pays anyone but the treasury the CHAIN names', () => {
    // The provider naming its own address here is taking elisym's cut.
    const request = requestJson({ fee_address: `0x${'ab'.repeat(20)}`, fee_amount: '250' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 250 }))?.code).toBe(
      'fee_address_mismatch',
    );
  });

  it.each([
    ['rounded down', '249'],
    ['inflated', '251'],
  ])('refuses a fee that is %s', (_label, feeAmount) => {
    const request = requestJson({ fee_address: TREASURY, fee_amount: feeAmount });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 250 }))?.code).toBe(
      'fee_amount_mismatch',
    );
  });

  it.each([
    ['100000', 99n],
    ['9', 10n],
  ])('compares %s against a price of %s as numbers, never as strings', (amount, price) => {
    const problem = validateTempoPaymentRequest(
      requestJson({ amount }),
      bounds({
        card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: price },
      }),
    );
    expect(problem?.code).toBe(amount === '100000' ? 'invalid_amount' : undefined);
  });

  it('treats a card with NO price as a bound of zero, not as no bound', () => {
    const problem = validateTempoPaymentRequest(
      requestJson({ amount: '1' }),
      bounds({ card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET } }),
    );
    expect(problem?.code).toBe('invalid_amount');
  });

  it('refuses an amount above the session cap', () => {
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({ maxAmountSubunits: 9_999n }),
    );
    expect(problem?.code).toBe('invalid_amount');
  });

  it('binds a card-less payment by the agreed asset and the session cap alone', () => {
    const bare = {
      chain: CHAINS.TEMPO_MAINNET,
      payer: PAYER,
      expectedAsset: USDCE_TEMPO_MAINNET,
      maxAmountSubunits: 50_000n,
      protocolFeeBps: 0,
      treasury: TREASURY,
      nowSecs: NOW,
    };
    expect(validateTempoPaymentRequest(requestJson({ amount: '40000' }), bare)).toBeNull();
    expect(
      validateTempoPaymentRequest(requestJson({ asset: `eip155:4217/erc20:${PATHUSD}` }), bare)
        ?.code,
    ).toBe('asset_mismatch');
  });
});

describe('checkTempoReceivePolicies', () => {
  function answering(answers: Record<string, string>) {
    return fakeTempoChain({
      onCall: (to, data) =>
        to.toLowerCase() === TEMPO_POLICY_REGISTRY
          ? (answers[`0x${data.slice(-40)}`] ?? YES)
          : '0x',
    });
  }
  const YES = `0x${'0'.repeat(63)}1${'0'.repeat(64)}`;
  const NO_SENDER = `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`;
  const NO_TOKEN = `0x${'0'.repeat(64)}${'1'.padStart(64, '0')}`;

  it('passes when both destinations accept this token from this payer', async () => {
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      feeAddress: TREASURY,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it.each([
    ['a sender policy', NO_SENDER],
    ['a token filter', NO_TOKEN],
  ])('refuses when the recipient blocks it by %s', async (_label, answer) => {
    const chain = answering({ [RECIPIENT]: answer });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'provider', reason: 'blocked' });
  });

  it('refuses when the TREASURY blocks the fee leg', async () => {
    const chain = answering({ [TREASURY]: NO_SENDER });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      feeAddress: TREASURY,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'fee', reason: 'blocked' });
  });

  it.each([
    ['nothing at all', '0x'],
    ['one word', `0x${'0'.repeat(64)}`],
    ['three words', `0x${'0'.repeat(64 * 3)}`],
  ])('refuses to pay blind when the registry answers %s', async (_label, answer) => {
    // Zero is the ACCEPTING value of the second word, so a short answer must
    // never be allowed to decode as permission.
    const chain = answering({ [RECIPIENT]: answer });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('refuses an authorized flag that carries a reason beside it', async () => {
    // `(1, 0)` and nothing else is a yes; a contradictory answer is read the
    // safe way round.
    const chain = answering({
      [RECIPIENT]: `0x${'1'.padStart(64, '0')}${'3'.padStart(64, '0')}`,
    });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('asks the registry at the FINALIZED head, never at the pending one', async () => {
    // A policy a reorg could take back is not one to pay against.
    const chain = answering({});
    await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      feeAddress: TREASURY,
    });
    const tags = chain.calls
      .filter((call) => call.method === 'eth_call')
      .map((call) => call.params?.[1]);
    expect(tags).toEqual(['finalized', 'finalized']);
  });

  it('does not ask about a fee leg there is none of', async () => {
    const asked: string[] = [];
    const chain = fakeTempoChain({
      onCall: (to, data) => {
        asked.push(`0x${data.slice(-40)}`);
        return YES;
      },
    });
    await checkTempoReceivePolicies(chain.client, {
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(asked).toEqual([RECIPIENT]);
  });
});

describe('resolveTempoTransferOutcome', () => {
  const BATCH = recordedReceipt('mainnet-batch-relayed');
  const BATCH_HASH = String(BATCH.transactionHash);
  const BATCH_BLOCK = Number(BigInt(String(BATCH.blockNumber)));
  const BATCH_MEMO = '0xe212c3626c6a7e1d7ea87da9bc16cd19de2f3478e76e47691f95a6fc4aec4634';
  const BLOCKED = recordedReceipt('moderato-blocked-pathusd');
  const BLOCKED_HASH = String(BLOCKED.transactionHash);
  const BLOCKED_BLOCK = Number(BigInt(String(BLOCKED.blockNumber)));
  const BLOCKED_MEMO = '0x626c6f636b65642073656e646572000000000000000000000000000000000000';

  const legs: TempoLegExpectation[] = [
    { token: USDCE, from: PAYER, to: RECIPIENT, amount: 10_000n, memo: BATCH_MEMO },
    { token: USDCE, from: PAYER, to: TREASURY, amount: 10_000n, memo: BATCH_MEMO },
  ];

  function chainWith(options: FakeChainOptions = {}) {
    return fakeTempoChain({
      finalized: 40_000_000,
      timestamps: { 40_000_000: NOW },
      ...options,
    });
  }

  it('calls the recorded batch DELIVERED, from its own receipt', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome.state).toBe('delivered');
    expect(outcome.state === 'delivered' && outcome.legs).toHaveLength(2);
  });

  it('will not call a transaction delivered on a leg that is not in it', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        ...legs,
        { token: USDCE, from: PAYER, to: `0x${'ab'.repeat(20)}`, amount: 1n, memo: BATCH_MEMO },
      ],
      { hash: BATCH_HASH, floor: BATCH_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome.state).toBe('pending');
  });

  it('never counts the network fee leg as a memo-less leg of ours', async () => {
    // Every Tempo receipt ends with a transfer to the fee sink, on a reverted
    // transaction too.
    const feeSink = '0xfeec000000000000000000000000000000000000';
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: feeSink, amount: 1n }],
      { hash: BATCH_HASH, floor: BATCH_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome.state).toBe('pending');
  });

  it('will not read a receipt that is not the transaction it asked about', async () => {
    // A load balancer answering from another backend hands back a stranger's
    // receipt. Reading its REVERTED status as ours would free this hash for a
    // replacement while ours is still in flight - both could land.
    const chain = chainWith({
      receipts: {
        [BATCH_HASH]: { ...BATCH, transactionHash: `0x${'99'.repeat(32)}`, status: '0x0' },
      },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('ignores a receipt log that claims a block the receipt is not in', async () => {
    const logs = (BATCH.logs as Record<string, unknown>[]).map((log) => ({
      ...log,
      blockNumber: '0x1',
    }));
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  /** Log 5 of the recorded batch: the gas leg. No memo, the customer as sender. */
  const GAS_LOG = (BATCH.logs as Record<string, unknown>[])[5] as Record<string, unknown>;
  const GAS_RECIPIENT = `0x${String((GAS_LOG.topics as string[])[2]).slice(26)}`;

  it('never counts a transfer to the fee sink as a memo-less leg of ours', async () => {
    // Every Tempo transaction ends with one of these, on a reverted one too.
    // A withdrawal expectation that matched it would report as delivered money
    // that the network took.
    const topics = GAS_LOG.topics as string[];
    const toFeeSink = {
      ...GAS_LOG,
      topics: [topics[0], topics[1], `0x${'0'.repeat(24)}${TEMPO_FEE_SINK.slice(2)}`],
    };
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: [toFeeSink] } } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: TEMPO_FEE_SINK, amount: 696n }],
      { hash: BATCH_HASH, floor: BATCH_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome.state).toBe('pending');
  });

  it('holds a memo-less leg to its EXACT amount, having nothing else to bind it', async () => {
    // A withdrawal carries no memo: the sender, the destination and the size
    // are the whole binding, so a transfer one subunit off is another one.
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: [GAS_LOG] } } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: GAS_RECIPIENT, amount: 695n }],
      { hash: BATCH_HASH, floor: BATCH_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome.state).toBe('pending');
  });

  it('does count the same memo-less leg at its exact amount', async () => {
    // The mirror: without this the row above would pass on a decode failure.
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: [GAS_LOG] } } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: GAS_RECIPIENT, amount: 696n }],
      { hash: BATCH_HASH, floor: BATCH_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome.state).toBe('delivered');
  });

  it('reads a blocked leg out of the receipt, and who may claim it', async () => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        {
          token: PATHUSD,
          from: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          amount: 25_000_000n,
          memo: BLOCKED_MEMO,
        },
      ],
      { hash: BLOCKED_HASH, floor: BLOCKED_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome).toMatchObject({
      state: 'blocked',
      claimableBy: '0x0000000000000000000000000000000000000001',
    });
  });

  it('calls a REVERTED transaction unsent: it moved nothing and its hash is spent', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, status: '0x0' } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'unsent', reason: 'reverted' });
  });

  it('says PENDING while the deadline has not passed, however empty the chain looks', async () => {
    const chain = chainWith({ receipts: {}, logs: [] });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('says UNSENT once the deadline passed and a complete pass finds nothing', async () => {
    const chain = chainWith({ receipts: {}, logs: [], timestamps: { 40_000_000: NOW + 600 } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'unsent', reason: 'deadline_passed' });
  });

  it.each([
    ['the pass could not finish', { onGetLogs: () => new Error('the node fell over') }],
    ['a leg IS on chain after all', { logs: receiptLogs(BATCH) }],
  ])('refuses to say unsent when %s', async (_label, options) => {
    const chain = chainWith({
      receipts: {},
      timestamps: { 40_000_000: NOW + 600 },
      ...options,
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('refuses to say unsent when the money is sitting with the GUARD', async () => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW + 600 },
      receipts: {},
      logs: receiptLogs(BLOCKED),
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        {
          token: PATHUSD,
          from: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          amount: 25_000_000n,
          memo: BLOCKED_MEMO,
        },
      ],
      { hash: BLOCKED_HASH, floor: BLOCKED_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('does not read a guard log for LESS than our leg as ours', async () => {
    // The parked amount has to cover what we sent, or it is somebody else's
    // blocked transfer to the same receiver.
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        {
          token: PATHUSD,
          from: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
          to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          amount: 25_000_001n,
          memo: BLOCKED_MEMO,
        },
      ],
      { hash: BLOCKED_HASH, floor: BLOCKED_BLOCK - 100, validBefore: NOW + 60 },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it.each([
    ['the transfer pass', TRANSFER_WITH_MEMO_TOPIC],
    ['the guard pass', TRANSFER_BLOCKED_TOPIC],
  ])('refuses to say unsent when %s alone could not finish', async (_label, topic) => {
    // Two separate scans, and each of them has to be complete on its own:
    // "nothing is on chain" must never rest on a pass that did not run.
    const chain = chainWith({
      receipts: {},
      logs: [],
      timestamps: { 40_000_000: NOW + 600 },
      onGetLogs: (call) => (call.topics[0] === topic ? new Error('the node fell over') : undefined),
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('says PENDING when the receipt read itself failed', async () => {
    const chain = chainWith({});
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_getTransactionReceipt') {
          throw new Error('rpc exploded');
        }
        return chain.client.request(args);
      },
    };
    const outcome = await resolveTempoTransferOutcome(client, legs, {
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW - 600,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('refuses to resolve nothing at all', async () => {
    const chain = chainWith({});
    await expect(
      resolveTempoTransferOutcome(chain.client, [], {
        hash: BATCH_HASH,
        floor: 1,
        validBefore: NOW,
      }),
    ).rejects.toThrow(/at least one expected leg/);
  });
});
