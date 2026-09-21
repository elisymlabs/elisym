/**
 * The customer's side of a Tempo payment: what must be true before money
 * moves, and what the sender may conclude about a transaction it sent.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPO_FEE_SINK,
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from '../src/evm/constants';
import { resolveTempoTransferOutcome, type TempoLegExpectation } from '../src/evm/outcome';
import {
  checkTempoReceivePolicies,
  MIN_PAY_WINDOW_SECS,
  validateTempoPaymentRequest,
} from '../src/evm/validate';
import { PATHUSD_TEMPO, USDCE_TEMPO_MAINNET } from '../src/payment/assets';
import { CHAINS } from '../src/payment/chains';
import {
  fakeTempoChain,
  rangeCapError,
  recordedReceipt,
  receiptLogs,
  type FakeChainOptions,
  type FakeLog,
} from './tempo-chain';

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

  it.each([
    ['asset', { asset: 'not-a-caip19' }, 'invalid_asset'],
    ['recipient', { recipient: 'not-an-address' }, 'invalid_recipient_address'],
    ['fee_address', { fee_address: 'not-an-address', fee_amount: '250' }, 'fee_address_mismatch'],
    ['fee_amount', { fee_address: TREASURY, fee_amount: 250 }, 'fee_amount_mismatch'],
    ['a field with no code of its own', { expiry_secs: -1 }, 'invalid_amount'],
    ['a version this rail does not speak', { v: 3 }, 'unsupported_version'],
  ])('maps a schema failure on %s to a code that names the field', (_label, fields, code) => {
    // The deviation this validator claims over the Solana one is that a
    // caller switching on the code never has to read English. Four of the
    // five mappings had no row, so four fifths of that claim was untested.
    expect(validateTempoPaymentRequest(requestJson(fields), bounds())?.code).toBe(code);
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

  it.each([
    ['the burn address', `0x${'0'.repeat(40)}`],
    ['the policy registry', TEMPO_POLICY_REGISTRY],
    ['the transfer guard', TEMPO_TRANSFER_GUARD],
    ['the network fee sink', TEMPO_FEE_SINK],
  ])('refuses a payment to %s, which nothing could ever confirm', (_label, recipient) => {
    const problem = validateTempoPaymentRequest(
      requestJson({ recipient }),
      bounds({ card: { recipient, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n } }),
    );
    expect(problem?.code).toBe('invalid_recipient_address');
  });

  it('refuses a FEE LEG paid to a protocol address as well', () => {
    // The config read refuses a zero or virtual treasury, not this one, and
    // the fee sink carries no receive policy - so the registry says yes and
    // the money is gone.
    const request = requestJson({ fee_address: TEMPO_FEE_SINK, fee_amount: '250' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 250 }))?.code).toBe(
      'invalid_recipient_address',
    );
  });

  it.each([
    ['a fraction of one', 0.5],
    ['negative', -1],
    ['not a number at all', Number.NaN],
  ])('refuses a fee rate that is %s', (_label, protocolFeeBps) => {
    // The fee arithmetic THROWS on each of these, and this function's contract
    // is to return a refusal. A whole negative number is caught by one half of
    // the guard and a fraction by the other, so both halves need a row.
    const request = requestJson({ fee_address: TREASURY, fee_amount: '250' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps }))?.code).toBe(
      'invalid_bounds',
    );
  });

  it.each([
    [
      'a card price',
      {
        card: {
          recipient: RECIPIENT,
          asset: USDCE_TEMPO_MAINNET,
          jobPriceSubunits: 'ten thousand',
        },
      },
    ],
    ['a session cap', { maxAmountSubunits: 'ten thousand' }],
  ])(
    'refuses %s that is not a number of subunits, even cast past the type',
    (_label, overrides) => {
      // A bigint compared against a string that is not a number converts to
      // nothing and the comparison is FALSE - so the bound would bound nothing.
      const problem = validateTempoPaymentRequest(
        requestJson({ amount: '999999999' }),
        bounds(overrides) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
      );
      expect(problem?.code).toBe('invalid_bounds');
    },
  );

  it.each([
    ['the payer', { payer: 42 }],
    ['the treasury', { treasury: 42 }],
    ['the card recipient', { card: { recipient: 42, asset: USDCE_TEMPO_MAINNET } }],
    ['the payer, absent', { payer: undefined }],
    ['the treasury, absent', { treasury: undefined }],
    ['the card recipient, absent', { card: { asset: USDCE_TEMPO_MAINNET } }],
  ])('refuses %s given as something that is not a string', (_label, overrides) => {
    // All three are lowercased before any guard sees them, and this function's
    // contract is to refuse, never to throw.
    const problem = validateTempoPaymentRequest(
      requestJson({ fee_address: TREASURY, fee_amount: '250' }),
      bounds({ protocolFeeBps: 250, ...overrides }) as unknown as Parameters<
        typeof validateTempoPaymentRequest
      >[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses a request ONE subunit above the card price', () => {
    // The two killer rows this bound has are `'100000'` against 99 and `'9'`
    // against 10, three orders of magnitude apart: a decimals slip is caught
    // and a plain tolerance is not. Measured, the comparison could be widened
    // 1010-fold before any test noticed.
    const problem = validateTempoPaymentRequest(
      requestJson({ amount: '10001' }),
      bounds({
        card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
      }),
    );
    expect(problem?.code).toBe('invalid_amount');
  });

  it('refuses a price bound given as a plain NUMBER, which money never crosses', () => {
    // 1e30 and 10n**30n are not the same value, and only one of them is money.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({
        card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000 },
      }) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses a fee rate one basis point over the contract ceiling', () => {
    const request = requestJson({ fee_address: TREASURY, fee_amount: '1001' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 1001 }))?.code).toBe(
      'invalid_bounds',
    );
  });

  it('accepts a fee rate exactly AT the contract ceiling', () => {
    const request = requestJson({ fee_address: TREASURY, fee_amount: '1000' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 1000 }))).toBeNull();
  });

  it.each([
    ['a card that is not a card', { card: null }],
    ['no chain at all', { chain: undefined }],
    ['a chain that is not a chain', { chain: null }],
    ['an asset that is not an asset', { card: undefined, expectedAsset: null }],
  ])('refuses bounds carrying %s rather than throwing', (_label, overrides) => {
    // Seventeen sibling shapes refuse; these four died on a property read.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds(overrides) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses bounds that bound no AMOUNT at all, even cast past the type', () => {
    // Without a card there is no recipient bound and no price bound, so the cap
    // is the whole binding. Absent, every amount to every address is payable -
    // the one shape the union's own comment says this function must never be
    // handed, and the sibling half already refuses its own version of it.
    const problem = validateTempoPaymentRequest(
      requestJson({ amount: '10000000000000' }),
      bounds({
        card: undefined,
        expectedAsset: USDCE_TEMPO_MAINNET,
        maxAmountSubunits: undefined,
      }) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses bounds whose card and session asset name DIFFERENT coins', () => {
    // The union allows both together and `??` takes the card's, dropping the
    // one the session agreed to without saying so.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({
        card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
        expectedAsset: PATHUSD_TEMPO,
      }),
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('accepts bounds whose card and session asset name the SAME coin', () => {
    expect(
      validateTempoPaymentRequest(
        requestJson(),
        bounds({
          card: { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 10_000n },
          expectedAsset: USDCE_TEMPO_MAINNET,
        }),
      ),
    ).toBeNull();
  });

  it('falls back to this machine’s clock when the caller names none', () => {
    // `nowSecs` is optional and every other row passes it, so the default was
    // exercised by nothing. A request created a year ago must be expired
    // against the real clock, not accepted because nobody looked.
    const yearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
    const problem = validateTempoPaymentRequest(
      requestJson({ created_at: yearAgo }),
      bounds({ nowSecs: undefined }),
    );
    expect(problem?.code).toBe('expired');
  });

  it('refuses bounds that name no asset at all, even cast past the type', () => {
    const castPastTheType = { ...bounds(), card: undefined } as unknown as Parameters<
      typeof validateTempoPaymentRequest
    >[1];
    expect(validateTempoPaymentRequest(requestJson(), castPastTheType)?.code).toBe('invalid_asset');
  });

  it('accepts the CHECKSUMMED addresses a wallet hands it', () => {
    // `getAddresses()` returns EIP-55, and `isEvmWireAddress` requires
    // lowercase - so without the normalisation the payer's own address is
    // refused as "not an address this rail can pay from". The card recipient
    // and the treasury arrive checksummed from the same kinds of place.
    const checksum = (address: string) => `0x${address.slice(2).toUpperCase()}`;
    const problem = validateTempoPaymentRequest(
      requestJson({ fee_address: TREASURY, fee_amount: '250' }),
      bounds({
        payer: checksum(PAYER),
        treasury: checksum(TREASURY),
        protocolFeeBps: 250,
        card: {
          recipient: checksum(RECIPIENT),
          asset: USDCE_TEMPO_MAINNET,
          jobPriceSubunits: 10_000n,
        },
      }),
    );
    expect(problem).toBeNull();
  });

  it.each([
    ['not a number', Number.NaN],
    ['a string of seconds', '1700000000'],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses bounds whose clock is %s', (_label, nowSecs) => {
    // `NaN` compares FALSE against all three time gates at once, so a request
    // that expired a day ago and one dated a year ahead both become payable;
    // a string turns `now + MIN_PAY_WINDOW_SECS` into concatenation. The
    // request is not judged at all - there is nothing to judge it against.
    const expired = requestJson({ created_at: NOW - 86_400 });
    expect(
      validateTempoPaymentRequest(expired, bounds({ nowSecs: nowSecs as unknown as number }))?.code,
    ).toBe('invalid_bounds');
  });

  it('refuses a fee rate above the contract’s own ceiling', () => {
    // The config read caps at 1000 bps, and this function is exported: its
    // doc says "the fee the chain says is due", and a caller that read it
    // somewhere else is still a caller.
    const request = requestJson({ fee_address: TREASURY, fee_amount: '9999' });
    expect(validateTempoPaymentRequest(request, bounds({ protocolFeeBps: 9999 }))?.code).toBe(
      'invalid_bounds',
    );
  });

  it('accepts a provider whose clock is a little fast', () => {
    // The skew window exists to be used: a request dated inside it is payable,
    // or a provider seconds ahead of us could never sell anything.
    const request = requestJson({ created_at: NOW + MIN_PAY_WINDOW_SECS });
    expect(validateTempoPaymentRequest(request, bounds())).toBeNull();
  });

  it('refuses a request dated exactly one second past the future window', () => {
    const request = requestJson({ created_at: NOW + MIN_PAY_WINDOW_SECS + 1 });
    expect(validateTempoPaymentRequest(request, bounds())?.code).toBe('future_timestamp');
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

  it('computes the fee from THIS request amount, at any amount', () => {
    // Every other fee row pays 10000 at 250 bps, where the fee is 250 - which
    // a constant would satisfy just as well as the arithmetic.
    const card = { recipient: RECIPIENT, asset: USDCE_TEMPO_MAINNET, jobPriceSubunits: 999_999n };
    const at = (amount: string, feeAmount: string) =>
      validateTempoPaymentRequest(
        requestJson({ amount, fee_address: TREASURY, fee_amount: feeAmount }),
        bounds({ protocolFeeBps: 250, card }),
      );
    expect(at('400000', '10000')).toBeNull();
    expect(at('400000', '250')?.code).toBe('fee_amount_mismatch');
    // And the rounding is UP: 250 bps of 9999 is 249.975.
    expect(at('9999', '250')).toBeNull();
    expect(at('9999', '249')?.code).toBe('fee_amount_mismatch');
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
  /**
   * Answers the registry's question, and only the RIGHT question: an argument
   * in the wrong slot turns a refusing destination into permission, so a fake
   * that keys on the recipient alone would not notice one.
   */
  function answering(answers: Record<string, string>) {
    return fakeTempoChain({
      onCall: (to, data) => {
        if (to.toLowerCase() !== TEMPO_POLICY_REGISTRY) {
          return '0x';
        }
        const words = data.slice(10).match(/.{64}/g) ?? [];
        const [token, payer, recipient] = words.map((word) => `0x${word.slice(24)}`);
        if (words.length !== 3 || token !== USDCE || payer !== PAYER) {
          return ASKED_THE_WRONG_QUESTION;
        }
        return answers[String(recipient)] ?? YES;
      },
    });
  }
  const YES = `0x${'0'.repeat(63)}1${'0'.repeat(64)}`;
  const NO_SENDER = `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`;
  const NO_TOKEN = `0x${'0'.repeat(64)}${'1'.padStart(64, '0')}`;
  /** What a registry asked about some other triple would say: never a yes. */
  const ASKED_THE_WRONG_QUESTION = `0x${'0'.repeat(64)}${'9'.padStart(64, '0')}`;

  it('passes when both destinations accept this token from this payer', async () => {
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
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
    // Zero is the accepting value of the SECOND word, so a refusal that names
    // no reason is still a refusal: `(1, 0)` and nothing else is a yes.
    ['a refusal with no reason given', `0x${'0'.repeat(64 * 2)}`],
  ])('refuses when the recipient blocks it by %s', async (_label, answer) => {
    const chain = answering({ [RECIPIENT]: answer });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'provider', reason: 'blocked' });
  });

  it('refuses when the TREASURY blocks the fee leg', async () => {
    const chain = answering({ [TREASURY]: NO_SENDER });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
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
      chain: CHAINS.TEMPO_MAINNET,
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
      chain: CHAINS.TEMPO_MAINNET,
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
      chain: CHAINS.TEMPO_MAINNET,
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

  it('refuses to pay blind when the registry read itself fails', async () => {
    const chain = fakeTempoChain({
      onCall: () => {
        throw new Error('rpc exploded');
      },
    });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('refuses a VIRTUAL destination rather than reading the alias policy', async () => {
    // TIP-1022: the registry answers for the alias, which can never carry a
    // policy, while the transfer is resolved to the master and the MASTER's
    // policy is what blocks it. The answer here is always "open" and always
    // meaningless.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: `0x11223344${'fd'.repeat(10)}556677889900`,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(chain.calls.filter((call) => call.method === 'eth_call')).toHaveLength(0);
  });

  it.each([
    ['names another chain', '0xa5bf'],
    ['will not say which chain it is', 7],
  ])('refuses to read a policy from an endpoint that %s', async (_label, chainId) => {
    // The registry lives at the same system address on both Tempo networks and
    // answers plausibly on either: measured live, a receiver that refuses on
    // its own chain answers `(1, 0)` - open - on the other. So the endpoint
    // has to identify itself before it is asked anything.
    const chain = fakeTempoChain({ chainId, onCall: () => YES });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(chain.calls.filter((call) => call.method === 'eth_call')).toHaveLength(0);
  });

  it('asks again which chain it is on before saying YES', async () => {
    // The registry lives at the same address on both networks and answers
    // plausibly on either, so a network switch between the gate and the last
    // read turns a refusal into permission to move money.
    let answered = 0;
    const chain = answering({});
    const switching = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId') {
          answered += 1;
          return answered === 1 ? '0x1079' : 7;
        }
        return chain.client.request(args);
      },
    };
    const verdict = await checkTempoReceivePolicies(switching, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(answered).toBe(2);
  });

  it.each([
    ['a token', { token: 'pathusd' }],
    ['a payer', { payer: '0x' }],
    ['a recipient', { recipient: undefined }],
    ['a fee address', { feeAddress: null }],
  ])('refuses %s that is not an address rather than throwing', async (_label, overrides) => {
    // Every one of these is spliced into a calldata template, which throws on
    // anything that is not a string. This function's contract is to answer a
    // verdict, the way its synchronous sibling does.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      ...overrides,
    } as unknown as Parameters<typeof checkTempoReceivePolicies>[1]);
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('accepts the CHECKSUMMED addresses a wallet hands it', async () => {
    // `getAddresses()` answers EIP-55. Refusing that spelling here refuses the
    // customer's own address before a single rpc call, and `unreadable` means
    // "do not sign" - so the customer simply cannot pay. The synchronous
    // sibling has had this row since round 3; this half went without one, and
    // round 10's own guard re-opened the trap.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE.toUpperCase().replace('0X', '0x'),
      payer: '0x0Ed8e782415d51EB7192cf0FcE9914a5Ed23bCe1',
      recipient: '0x5696dA2ceCEA22f127948458382Ac2c59bc8E4bb',
    });
    expect(verdict).toEqual({ ok: true });
    // One leg, one read: the treasury is only asked when a fee address is given.
    expect(chain.calls.filter((call) => call.method === 'eth_call')).toHaveLength(1);
  });

  it('asks the registry with the TIP-403 selector, not merely at its address', async () => {
    // The fake checks where the call goes and how its arguments are laid out;
    // nothing said which function is being called.
    const chain = answering({});
    await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    const calls = chain.calls.filter((call) => call.method === 'eth_call');
    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      const data = String((call.params?.[0] as { data?: unknown } | undefined)?.data);
      expect(data.slice(0, 10)).toBe('0xb72b0c59');
    }
  });

  it('refuses a VIRTUAL payer without asking either', async () => {
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: `0x11223344${'fd'.repeat(10)}556677889900`,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(chain.calls.filter((call) => call.method === 'eth_call')).toHaveLength(0);
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
      chain: CHAINS.TEMPO_MAINNET,
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

  /** The guard's own logs out of a recorded receipt, in the shape a scan finds them. */
  function guardLogsOf(receipt: Record<string, unknown>): FakeLog[] {
    return receiptLogs(receipt).filter((log) => log.topics[0] === TRANSFER_BLOCKED_TOPIC);
  }

  /** Rewrite one 32-byte word of a log's data, keeping every other byte. */
  function withDataWord(log: Record<string, unknown>, index: number, word: string) {
    const data = String(log.data);
    return {
      ...log,
      data: `${data.slice(0, 2 + index * 64)}${word}${data.slice(2 + (index + 1) * 64)}`,
    };
  }
  const BLOCKED_RECOVERY_WORD = 6;

  /** The Moderato receipt's blocked leg, as the sender expected to send it. */
  const BLOCKED_LEG: TempoLegExpectation = {
    token: PATHUSD,
    from: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    amount: 25_000_000n,
    memo: BLOCKED_MEMO,
  };

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

  /**
   * Ordinary traffic on the token just below each edge of the scan. Without it
   * the endpoint cannot be shown to hold this token's history, and `unsent` -
   * the verdict that tells a caller to send the money again - may not be
   * reached from an empty window.
   */
  /** An address as a 32-byte topic word, the way a node writes it. */
  function topicWord(address: string): string {
    return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  }

  function history(token: string, ...edges: number[]) {
    return edges.map((edge, index) => ({
      address: token,
      topics: [`0x${'55'.repeat(32)}`],
      data: '0x',
      blockNumber: edge - 50,
      transactionHash: `0x${String(index + 4).repeat(64)}`,
      logIndex: 0,
    }));
  }

  it('will not satisfy a memo leg with a plain Transfer to the same destination', async () => {
    // A `Transfer` carries no memo at all. Comparing two absent words as equal
    // would let any transfer of the right size to the right address complete a
    // memo leg - and a memo is the only thing binding a transfer to a request.
    const plain: FakeLog = {
      address: USDCE,
      topics: [TRANSFER_TOPIC, topicWord(PAYER), topicWord(RECIPIENT)],
      data: `0x${10_000n.toString(16).padStart(64, '0')}`,
      blockNumber: BATCH_BLOCK,
      transactionHash: BATCH_HASH,
      logIndex: 0,
    };
    const chain = chainWith({
      receipts: {
        [BATCH_HASH]: {
          ...BATCH,
          logs: [plain].map((log) => ({
            ...log,
            blockNumber: `0x${log.blockNumber.toString(16)}`,
            logIndex: '0x0',
            removed: false,
          })),
        },
      },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: USDCE, from: PAYER, to: RECIPIENT, amount: 10_000n, memo: BATCH_MEMO }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('will not prove an absence with the memo spelled as the CALLER holds it', async () => {
    // The scan filters on a topic, and the comparison inside it is exact. A
    // caller holding its own memo upper-cased would filter on a word no log
    // carries, find nothing, and call the window complete and empty - `unsent`
    // on a payment that is on chain. The memo goes into the filter lowercased.
    const memoLog = receiptLogs(BATCH).find(
      (log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC && log.topics[3] === BATCH_MEMO,
    );
    const chain = chainWith({
      receipts: {},
      logs: [
        ...history(USDCE, BATCH_BLOCK - 100, 40_000_000),
        ...(memoLog === undefined ? [] : [memoLog]),
      ],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const shouting = BATCH_MEMO.toUpperCase().replace('0X', '0x');
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ ...legs[0], memo: shouting }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('does not credit a memo leg that agrees on only PART of the word', async () => {
    // Comparing the first four bytes, or the last four, survives every other
    // row: a memo is 32 bytes and all of them bind.
    const first = `${BATCH_MEMO.slice(0, 10)}${'0'.repeat(56)}`;
    const last = `0x${'0'.repeat(56)}${BATCH_MEMO.slice(-8)}`;
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    for (const memo of [first, last]) {
      const outcome = await resolveTempoTransferOutcome(chain.client, [{ ...legs[0], memo }], {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      });
      expect(outcome).toEqual({ state: 'pending' });
    }
  });

  it('calls the recorded batch DELIVERED when the caller holds its memo in UPPER case', async () => {
    // Every address on a leg goes through `sameAddress`; the memo was the one
    // binding compared raw. A caller that stored its own memo checksummed or
    // upper-cased would match no log and no receipt - `pending` for ever, on
    // money that moved.
    const shouting = legs.map((leg) => ({
      ...leg,
      ...(leg.memo === undefined ? {} : { memo: leg.memo.toUpperCase().replace('0X', '0x') }),
    }));
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(chain.client, shouting, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toMatchObject({ state: 'delivered' });
  });

  it('calls the recorded batch DELIVERED, from its own receipt', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
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
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
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
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
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
      chain: CHAINS.TEMPO_MAINNET,
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
      chain: CHAINS.TEMPO_MAINNET,
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
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
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
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('pending');
  });

  it('does count the same memo-less leg at its exact amount', async () => {
    // The mirror: without this the row above would pass on a decode failure.
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: [GAS_LOG] } } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: GAS_RECIPIENT, amount: 696n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('delivered');
  });

  it.each([
    ['one subunit more than the log carries', { amount: 10_001n }],
    ['another memo', { memo: `0x${'ab'.repeat(32)}` }],
  ])('does not credit a memo leg that asked for %s', async (_label, changes) => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      legs.map((leg) => ({ ...leg, ...changes })),
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('pending');
  });

  it('does not credit a memo-less leg to a transfer from someone else', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: [GAS_LOG] } } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: `0x${'ab'.repeat(20)}`, to: GAS_RECIPIENT, amount: 696n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('pending');
  });

  it('ignores a receipt log that names another TRANSACTION', async () => {
    const logs = (BATCH.logs as Record<string, unknown>[]).map((log) => ({
      ...log,
      transactionHash: `0x${'77'.repeat(32)}`,
    }));
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
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
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toMatchObject({
      state: 'blocked',
      claimableBy: '0x0000000000000000000000000000000000000001',
    });
  });

  it.each([
    ['another receiver', { to: `0x${'cd'.repeat(20)}` }],
    ['another token', { token: USDCE }],
    ['another memo', { memo: `0x${'ab'.repeat(32)}` }],
  ])('does not read a guard log for %s as our blocked leg', async (_label, changes) => {
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ ...BLOCKED_LEG, ...changes }],
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).not.toBe('blocked');
  });

  it.each([
    ['another transaction', { transactionHash: `0x${'77'.repeat(32)}` }],
    ['another block', { blockNumber: '0x1' }],
  ])('ignores a guard log in the receipt that claims %s', async (_label, changes) => {
    const logs = (BLOCKED.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC ? { ...log, ...changes } : log,
    );
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs } },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome.state).not.toBe('blocked');
  });

  it('calls a REVERTED transaction unsent: it moved nothing and its hash is spent', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, status: '0x0' } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'unsent', reason: 'reverted' });
  });

  it('says PENDING while the deadline has not passed, however empty the chain looks', async () => {
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('says UNSENT once the deadline passed and a complete pass finds nothing', async () => {
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'unsent', reason: 'deadline_passed' });
  });

  it.each([
    ['the floor of the scan', 40_000_000],
    ['its head', BATCH_BLOCK - 100],
  ])('refuses to say unsent on an endpoint with no history at %s', async (_label, edge) => {
    // BOTH edges are asked, and they are not interchangeable: the floor edge
    // is the one that catches a node whose logs are pruned behind it. The
    // window walks BACKWARD, so a node that will not serve a wide one is what
    // keeps the head's control from reaching the floor's traffic and passing
    // for it.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, edge),
      timestamps: { 40_000_000: NOW + 600 },
      onGetLogs: (call) => (call.toBlock - call.fromBlock >= 4_096 ? rangeCapError() : undefined),
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('needs a block PAST the deadline, not one at it', async () => {
    // `valid_before` is strict: a block whose timestamp EQUALS it cannot carry
    // the transaction either, so that block is proof like any later one.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 60 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'unsent', reason: 'deadline_passed' });
  });

  it('refuses to say unsent one second before the deadline', async () => {
    // `valid_before` is strict: a block at or past it cannot include the
    // transaction, and a block one second short of it still can.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 59 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('scans up to the finalized block itself, so a transfer in it is found', async () => {
    // The pass ends AT the finalized number, not one short of it: a leg in the
    // very block the scan reached is on chain like any other.
    const inTheLastBlock = receiptLogs(BATCH)
      .filter((log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC)
      .map((log) => ({ ...log, blockNumber: 40_000_000 }));
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), ...inTheLastBlock],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('and the GUARD pass starts at the floor INCLUSIVE, so money parked there is found', async () => {
    // The same edge as the transfer pass, on the branch that proves the money
    // was not stopped rather than not sent. The floor is the block the sender
    // read before broadcasting, so it is a block the transaction can be in.
    const floor = BLOCKED_BLOCK - 100;
    const parkedAtTheFloor = guardLogsOf(BLOCKED).map((log) => ({ ...log, blockNumber: floor }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW + 600 },
      receipts: {},
      logs: [...history(PATHUSD, floor, 35_790_000), ...parkedAtTheFloor],
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('and the GUARD pass ends there too, so money parked in it is found', async () => {
    const parkedInTheLastBlock = guardLogsOf(BLOCKED).map((log) => ({
      ...log,
      blockNumber: 35_790_000,
    }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW + 600 },
      receipts: {},
      logs: [...history(PATHUSD, BLOCKED_BLOCK - 100, 35_790_000), ...parkedInTheLastBlock],
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('refuses a guard log whose recovery authority is not an address', async () => {
    // Word 6 is read as an address and typed as a string. Dirty high bytes
    // make it unreadable, and calling the log readable anyway hands a caller
    // `claimableBy: null` for money that is parked - a wrong answer about who
    // can get it back, in the one verdict that exists to say so.
    const dirty = (BLOCKED.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC
        ? withDataWord(log, BLOCKED_RECOVERY_WORD, `ff${'0'.repeat(62)}`)
        : log,
    );
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs: dirty } },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('finds money PARKED with the guard when the caller holds its memo in UPPER case', async () => {
    // Round 11 made both memo comparisons case-insensitive and only the
    // transfer one got a row. Reverting this branch alone leaves the whole
    // suite green and turns 25000000 subunits parked with the guard into
    // `unsent` - the money is stopped AND sent a second time.
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const shouting = {
      ...BLOCKED_LEG,
      memo: BLOCKED_LEG.memo?.toUpperCase().replace('0X', '0x'),
    } as TempoLegExpectation;
    const outcome = await resolveTempoTransferOutcome(chain.client, [shouting], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toMatchObject({ state: 'blocked' });
  });

  it('finds the SECOND leg of a payment parked with the guard', async () => {
    // `expected.find(matchesBlocked)` over a two-leg receipt: narrowing it to
    // the first leg leaves 183 tests green while the treasury's leg, stopped
    // by the guard, answers `pending` for ever - money parked and nobody told
    // who may claim it.
    const provider = { ...BLOCKED_LEG, to: RECIPIENT, memo: BATCH_MEMO };
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [provider, BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toMatchObject({ state: 'blocked', leg: BLOCKED_LEG });
  });

  it('names the guard log’s own originator when nobody may recover the funds', async () => {
    // Both recorded fixtures carry a recovery authority, so this branch - the
    // one where the sender gets its money back - was never entered. The leg's
    // `from` is who we EXPECTED to send it; a relayer may have.
    const relayed = (BLOCKED.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC
        ? withDataWord(log, BLOCKED_RECOVERY_WORD, '0'.repeat(64))
        : log,
    );
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs: relayed } },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ ...BLOCKED_LEG, from: `0x${'ab'.repeat(20)}` }],
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toMatchObject({ state: 'blocked', claimableBy: BLOCKED_LEG.from });
  });

  it.each([
    ['not a number', Number.NaN],
    ['absent', undefined],
    // `timestamp < -Infinity` is false, so this one passes the gate and
    // reaches `unsent` on a transaction with no deadline at all.
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('refuses a deadline that is %s rather than reading one', async (_label, validBefore) => {
    // Each of these compares FALSE against a block timestamp, which would pass
    // the deadline gate and reach `unsent` on a live transaction.
    const chain = chainWith({ receipts: {}, logs: [] });
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: validBefore as unknown as number,
      }),
    ).rejects.toThrow(/needs a deadline/);
  });

  it('will not prove the absence of a memo-less leg from a VIRTUAL sender', async () => {
    // The alias is resolved before the transfer is recorded, so the scan's
    // `from` topic names an address no log can carry and the absence it proves
    // is vacuous.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        {
          token: USDCE,
          from: `0x11223344${'fd'.repeat(10)}556677889900`,
          to: RECIPIENT,
          amount: 1n,
        },
      ],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('asks again which chain it is on before saying UNSENT', async () => {
    // A browser wallet's user clicking "switch network" mid-call is not a
    // fault, it is Tuesday - and everything the absence proof read came from
    // the endpoint as it was. `unsent` is the answer that spends the money a
    // second time, so the endpoint is asked once more.
    for (const moved of ['0xa5bf', 7, null]) {
      let answered = 0;
      const chain = chainWith({
        receipts: {},
        logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
        timestamps: { 40_000_000: NOW + 600 },
      });
      const switching = {
        request: async (args: { method: string; params?: readonly unknown[] }) => {
          if (args.method === 'eth_chainId') {
            answered += 1;
            // The first answer is this chain; by the second the user has moved
            // - to a NAMED other chain, to one this SDK cannot read, or to an
            // endpoint that will not say. None of the three is a fault to
            // throw at a polling loop, and none of them is `unsent`.
            return answered === 1 ? '0x1079' : moved;
          }
          return chain.client.request(args);
        },
      };
      const outcome = await resolveTempoTransferOutcome(switching, legs, {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      });
      expect(outcome).toEqual({ state: 'pending' });
      expect(answered).toBe(2);
    }
  });

  it('refuses a chain whose family is right but whose id is missing', async () => {
    // The row below names a Solana chain, where both halves of the gate are
    // true at once; neither half was pinned on its own.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const noId = { ...CHAINS.TEMPO_MAINNET, evmChainId: undefined };
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        chain: noId as unknown as typeof CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      }),
    ).rejects.toThrow(/cannot read/);
  });

  it('refuses a chain this rail cannot read at all, loudly', async () => {
    // One identifier away from right in a dual-rail SDK. Swallowing it would
    // poll `pending` for ever with no rpc traffic to notice it by.
    const chain = chainWith({ receipts: {} });
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        chain: CHAINS.SOLANA_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      }),
    ).rejects.toThrow(/cannot read solana/);
    expect(chain.calls).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a second in 1970', 1],
    ['a small counter', 12_345],
    // The likeliest slip of all: `Date.now()` where seconds were meant. It
    // clears the floor by three orders of magnitude and the chain's clock
    // never reaches it, so the answer would be `pending` for ever.
    ['in milliseconds', 1_700_000_060_000],
  ])('refuses a deadline of %s, which is a number but not a time', async (_label, validBefore) => {
    // `finalized.timestamp >= validBefore` is true on the first read for any
    // of these, so a complete empty scan would answer `unsent` at once about a
    // transaction still in the mempool.
    const chain = chainWith({ receipts: {} });
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore,
      }),
    ).rejects.toThrow(/needs a deadline/);
  });

  it.each([
    ['expects nothing', [{ amount: 0n }]],
    ['expects a plain number of subunits', [{ amount: 10_000 }]],
    ['is the SECOND of two and expects nothing', [{}, { amount: 0n }]],
  ])('refuses a leg that %s', async (_label, changes) => {
    // A zero-amount `transferFromWithMemo` succeeds from any caller, so a leg
    // of nothing is `delivered` by a log that moved nothing; and a `number`
    // amount equals no bigint, so such a leg is `pending` for ever.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        changes.map((change, index) => ({
          ...legs[index % legs.length],
          ...change,
        })) as TempoLegExpectation[],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/positive amount of subunits/);
  });

  it('refuses a leg that expects nothing, which any forged log satisfies', async () => {
    // A zero-amount `transferFromWithMemo` succeeds from any caller, so a leg
    // of nothing is `delivered` by a log that moved nothing.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [{ ...legs[0], amount: 0n } as TempoLegExpectation],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/positive amount/);
  });

  it('proves nothing about a blocked WITHDRAWAL either, when the guard pass fails', async () => {
    // The only absence-proof guard row used a memo leg; a withdrawal has none,
    // and its guard pass is a different branch of the same scan.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
      onGetLogs: (call) =>
        call.topics[0] === TRANSFER_BLOCKED_TOPIC ? new Error('the node fell over') : undefined,
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: USDCE, from: PAYER, to: RECIPIENT, amount: 10_000n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it.each([
    ['no legs at all', []],
    ['legs that are not a list', 'legs'],
  ])('refuses %s, which nothing can fail to satisfy', async (_label, expected) => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(chain.client, expected as unknown as TempoLegExpectation[], {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      }),
    ).rejects.toThrow(/at least one expected leg/);
  });

  it.each([
    ['a token', { token: 'pathusd' }],
    ['a receiver', { to: 'the provider' }],
    // Hex, and still not an address: these pass a guard that only asks for a
    // `0x`, and then match no log at all.
    ['a token that is only a prefix', { token: '0x' }],
    ['a receiver three bytes long', { to: '0xabcdef' }],
  ])('refuses a leg naming %s that is not an address', async (_label, overrides) => {
    // Every address is matched by lowercasing it and comparing; one that is not
    // an address matches no log, so the leg is `pending` for ever.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [{ ...legs[0], ...overrides } as TempoLegExpectation],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/name a token and a receiver/);
  });

  it.each([
    ['empty', ''],
    ['a bare prefix', '0x'],
    ['four bytes', '0xdeadbeef'],
    ['thirty-one bytes', `0x${'ab'.repeat(31)}`],
    ['sixty-four hex with no prefix', 'ab'.repeat(32)],
    ['not a string at all', 42],
  ])('refuses a leg memo that is %s', async (_label, memo) => {
    // The memo is the only thing binding a transfer to a request, and it was
    // the one leg field with no shape guard while seven others had one. A
    // value that matches no log is `unsent` on the absence path - pay it again
    // for money that is on chain - and `pending` for ever on the receipt path.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [{ ...legs[0], memo } as unknown as TempoLegExpectation],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/32-byte word/);
  });

  it.each([
    ['a memo that is not a word', { memo: '0xdeadbeef' }, /32-byte word/],
    ['a receiver that is not an address', { to: 'the treasury' }, /name a token and a receiver/],
    ['an amount that is not subunits', { amount: 10_000 }, /positive amount/],
  ])('refuses %s on the SECOND leg of an atomic payment', async (_label, overrides, message) => {
    // Every one of these guards reads `expected.some(...)`, and every other
    // row hands it one leg - so a check narrowed to the first leg passes the
    // whole suite. An atomic payment is two legs, and the fee leg is the one
    // no row reached: a malformed second leg means `pending` for ever on money
    // that arrived, which is exactly what these guards exist to prevent.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [legs[0], { ...legs[1], ...overrides } as TempoLegExpectation],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(message);
  });

  it('refuses a memo-LESS leg whose sender is not an address', async () => {
    // A memo leg is paid by anyone, so its `from` binds nothing; a withdrawal
    // is bound by its sender in the transfer pass and in the guard pass both.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [{ token: USDCE, from: 'me', to: RECIPIENT, amount: 10_000n } as TempoLegExpectation],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/name its sender/);
  });

  it('scans from the floor INCLUSIVE, so a transfer in that very block counts', async () => {
    // The floor is the finalized number read before the transaction was sent,
    // so the transaction can be in that block. Starting one above it proves an
    // absence over a window that excludes the likeliest block of all.
    const floor = BATCH_BLOCK - 100;
    const moved: FakeLog = {
      address: USDCE,
      topics: [TRANSFER_TOPIC, topicWord(PAYER), topicWord(RECIPIENT)],
      data: `0x${10_000n.toString(16).padStart(64, '0')}`,
      blockNumber: floor,
      transactionHash: `0x${'d2'.repeat(32)}`,
      logIndex: 0,
    };
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, floor, 40_000_000), moved],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: USDCE, from: PAYER, to: RECIPIENT, amount: 10_000n }],
      { chain: CHAINS.TEMPO_MAINNET, hash: BATCH_HASH, floor, validBefore: NOW + 60 },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('finds a WITHDRAWAL that MOVED, which emits a plain Transfer and no memo log', async () => {
    // A withdrawal is a plain `Transfer`. Asking the scan for a memo log
    // instead finds nothing, and a complete empty pass past the deadline is
    // the proof `unsent` rests on - so the money would be sent twice.
    const moved: FakeLog = {
      address: USDCE,
      topics: [TRANSFER_TOPIC, topicWord(PAYER), topicWord(RECIPIENT)],
      data: `0x${10_000n.toString(16).padStart(64, '0')}`,
      blockNumber: BATCH_BLOCK,
      transactionHash: `0x${'d1'.repeat(32)}`,
      logIndex: 0,
    };
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), moved],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: USDCE, from: PAYER, to: RECIPIENT, amount: 10_000n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('finds a WITHDRAWAL parked with the guard, which carries no memo to find it by', async () => {
    // A memo leg is recognised in the guard's log by its memo. A withdrawal has
    // none, so the only thing binding that log to this leg is the originator -
    // a different branch of the same function, and the money at stake is the
    // whole withdrawal: without it the answer is `unsent`, which means send it
    // again.
    const parked = guardLogsOf(BLOCKED).map((log) => ({ ...log, blockNumber: 35_789_900 }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW + 600 },
      receipts: {},
      // A blocked transfer emits no memo log, so the transfer pass finds
      // nothing and the guard pass is the only thing standing between this
      // withdrawal and a second one.
      logs: [...history(PATHUSD, BLOCKED_BLOCK - 100, 35_790_000), ...parked],
    });
    const withdrawal = {
      token: BLOCKED_LEG.token,
      from: BLOCKED_LEG.from,
      to: BLOCKED_LEG.to,
      amount: BLOCKED_LEG.amount,
    };
    const outcome = await resolveTempoTransferOutcome(chain.client, [withdrawal], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('will not prove an absence on an endpoint that cannot say which chain it is', async () => {
    // pathUSD lives at the SAME address on both Tempo networks, the guard and
    // the registry are system addresses on both, and mainnet's head is higher
    // than Moderato's - so a Moderato transfer looked for on mainnet finds an
    // endpoint that answers every question plausibly and holds none of our
    // money. That is `unsent`: send it again.
    const chain = chainWith({
      chainId: 7,
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('throws rather than read an endpoint that is ANOTHER chain', async () => {
    // A misconfiguration the caller has to fix, and the same class of caller
    // error as a hash that is not a hash: every answer would be about somebody
    // else's chain.
    const chain = chainWith({ chainId: '0xa5bf', receipts: {} });
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      }),
    ).rejects.toThrow(/not chain 4217/);
  });

  it('will not prove the absence of a transfer to a VIRTUAL destination', async () => {
    // The guard names the MASTER when it parks a transfer to an alias, so the
    // guard pass - which asks about the alias - cannot see it, and a blocked
    // transfer emits no memo log for the other pass to find. Together they
    // read as "never sent" about money that has already left the account.
    const alias = `0x11223344${'fd'.repeat(10)}556677889900`;
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ ...legs[0], to: alias } as TempoLegExpectation],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('refuses to say unsent on an endpoint that cannot show the token has history', async () => {
    // A node with pruned logs answers an empty list with no error, which is
    // exactly what "the transaction never landed" looks like - and here that
    // reading tells the caller to send the money a second time.
    const chain = chainWith({ receipts: {}, logs: [], timestamps: { 40_000_000: NOW + 600 } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('will not say unsent while only the SECOND leg is unaccounted for', async () => {
    // Every expected leg is scanned. A two-transaction payment whose fee leg
    // landed and whose provider leg did not is not "unsent" - replacing it
    // would pay the fee twice.
    const providerLeg = receiptLogs(BATCH).filter(
      (log) =>
        log.topics[0] === TRANSFER_WITH_MEMO_TOPIC && log.topics[2]?.endsWith(RECIPIENT.slice(2)),
    );
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), ...providerLeg],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [legs[1], legs[0]] as typeof legs,
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it.each([
    ['the pass could not finish', { onGetLogs: () => new Error('the node fell over') }],
    ['a leg IS on chain after all', { logs: receiptLogs(BATCH) }],
  ])('refuses to say unsent when %s', async (_label, options) => {
    const chain = chainWith({
      receipts: {},
      timestamps: { 40_000_000: NOW + 600 },
      ...options,
      // Merged, never replaced: without history at both edges every row below
      // would answer `pending` for the control's reason instead of its own.
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), ...(options.logs ?? [])],
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
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
      logs: [...history(PATHUSD, BLOCKED_BLOCK - 100, 35_790_000), ...receiptLogs(BLOCKED)],
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
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
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
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });

  it.each([
    ['the transfer pass', TRANSFER_WITH_MEMO_TOPIC],
    ['the guard pass', TRANSFER_BLOCKED_TOPIC],
  ])('refuses to say unsent when %s alone could not finish', async (_label, topic) => {
    // Two separate scans, and each of them has to be complete on its own:
    // "nothing is on chain" must never rest on a pass that did not run. The
    // history control asks UNFILTERED, so it still answers here.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
      onGetLogs: (call) => (call.topics[0] === topic ? new Error('the node fell over') : undefined),
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('counts a memo leg PAID BY ANYONE when proving one was never sent', async () => {
    // A leg found by memo counts as done whoever paid it - a relayer, a
    // batcher, a friend. Binding the absence scan to the sender we expected
    // would answer `unsent` on money that is on chain, and send it again.
    const paidByAnother = receiptLogs(BATCH)
      .filter((log) => log.topics[0] === TRANSFER_WITH_MEMO_TOPIC)
      .map((log) => ({
        ...log,
        topics: [
          log.topics[0],
          `0x${'0'.repeat(24)}${'ab'.repeat(20)}`,
          log.topics[2],
          log.topics[3],
        ],
      }));
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), ...paidByAnother],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('does not call a receipt DELIVERED when its success could not be read', async () => {
    // `status` as the JSON number 1 is a real endpoint shape. Unreadable is
    // not success, on the sender's side as much as the receiver's.
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, status: 1 } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('reads legs given in CHECKSUMMED form off its own receipt', async () => {
    // The legs are caller-built and normalised nowhere. 5b-ii builds them from
    // a browser wallet, whose addresses are EIP-55 - and a leg that matches
    // nothing answers `pending` for ever on a payment that landed.
    const checksum = (address: string) => `0x${address.slice(2).toUpperCase()}`;
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      legs.map((leg) => ({
        ...leg,
        token: checksum(leg.token),
        from: checksum(leg.from),
        to: checksum(leg.to),
      })),
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('delivered');
  });

  it('stops on a signal that fires after the CHAIN GATE', async () => {
    // Between the gate and the receipt read, which is the next thing that
    // takes the signal. The verdict is `pending` either way; what says the
    // signal was honoured is that the absence proof never starts.
    const controller = new AbortController();
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        // Set before the receipt read is awaited, so the gate above has
        // already settled and this is the first read the signal reaches.
        if (args.method === 'eth_getTransactionReceipt') {
          controller.abort();
        }
        return chain.client.request(args);
      },
    };
    const outcome = await resolveTempoTransferOutcome(client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ state: 'pending' });
    expect(chain.calls.map((call) => call.method)).toEqual([
      'eth_chainId',
      'eth_getTransactionReceipt',
    ]);
  });

  it('stops on a signal that fires AFTER the receipt read', async () => {
    // The receipt is not the only read that takes the signal: the absence
    // proof is four more, and each of them is a scan that would otherwise
    // keep asking.
    const controller = new AbortController();
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    // Aborting on the BLOCK read, not the receipt: an abort during the receipt
    // read is caught by that read's own wrapper and never reaches the scans,
    // which are the four this row is about.
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        const answer = await chain.client.request(args);
        if (args.method === 'eth_getBlockByNumber') {
          controller.abort();
        }
        return answer;
      },
    };
    const outcome = await resolveTempoTransferOutcome(client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ state: 'pending' });
    expect(chain.getLogsCalls).toEqual([]);
  });

  it('says PENDING when the finalized block comes back as nothing', async () => {
    // Not an error - an answer of the wrong shape, which is what an endpoint
    // that does not serve the `finalized` tag returns. Reading it as a number
    // throws inside the scan instead of answering.
    const chain = chainWith({ receipts: {}, finalized: null });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW - 600,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('says PENDING for a receipt whose logs are not a list', async () => {
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: null } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('stops on an aborted signal rather than scanning the chain twice over', async () => {
    // Every read here takes the caller's signal. Without them an abandoned
    // resolve keeps issuing up to 512 log queries per leg plus the control's.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
      signal: AbortSignal.abort(),
    });
    expect(outcome).toEqual({ state: 'pending' });
    // And it stops at the first read AFTER the chain gate: the verdict is the
    // same either way, so the only thing that says the signal was honoured is
    // the work not done. The scan bails on an aborted signal before asking
    // anything, so counting log queries would not notice - the block read
    // after the receipt does. (This row pins the receipt read alone; the row
    // above pins the four in the absence proof, by aborting once the receipt
    // has answered.)
    // The chain gate is the first read and takes the signal like every other,
    // so an already-aborted caller stops there.
    expect(chain.calls.map((call) => call.method)).toEqual(['eth_chainId']);
  });

  it('reads a guard log that parked MORE than the leg asked for as ours', async () => {
    // The rule is "covers the leg", not "equals it". An overpaid transfer
    // bounced by the receiver's policy is still our money with the guard, and
    // calling it unsent would send it a second time.
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ ...BLOCKED_LEG, amount: 24_999_999n }],
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toMatchObject({ state: 'blocked' });
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
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW - 600,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('reads the hash a wallet reports in ANY case', async () => {
    // Every hash off the chain is lowercase. An uppercase one matched no
    // receipt and no log, and a non-null receipt can never reach the absence
    // proof - so the answer was `pending` for ever, on a payment that landed.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: `0x${BATCH_HASH.slice(2).toUpperCase()}`,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome.state).toBe('delivered');
  });

  it('refuses something that was never a transaction hash', async () => {
    const chain = chainWith({});
    await expect(
      resolveTempoTransferOutcome(chain.client, legs, {
        hash: 'the-transaction',
        floor: 1,
        validBefore: NOW,
      }),
    ).rejects.toThrow(/needs a transaction hash/);
  });

  it('refuses to resolve nothing at all', async () => {
    const chain = chainWith({});
    await expect(
      resolveTempoTransferOutcome(chain.client, [], {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: 1,
        validBefore: NOW,
      }),
    ).rejects.toThrow(/at least one expected leg/);
  });
});
