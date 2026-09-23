/**
 * The customer's side of a Tempo payment: what must be true before money
 * moves, and what the sender may conclude about a transaction it sent.
 */
import { describe, expect, it } from 'vitest';
import {
  EARLIEST_TEMPO_SECONDS,
  LATEST_TEMPO_SECONDS,
  TEMPO_ADDRESS_REGISTRY,
  TEMPO_FEE_SINK,
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
  ZERO_ADDRESS,
} from '@elisym/pay-core';
import { resolveTempoTransferOutcome, type TempoLegExpectation } from '@elisym/pay-core';
import {
  checkTempoReceivePolicies,
  MIN_PAY_WINDOW_SECS,
  validateTempoPaymentRequest,
} from '@elisym/pay-core';
import { PATHUSD_TEMPO, USDCE_TEMPO_MAINNET } from '@elisym/pay-core';
import { CHAINS } from '@elisym/pay-core';
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
    ['a field with no code of its own', { expiry_secs: -1 }, 'invalid_json'],
    ['the amount itself', { amount: -1 }, 'invalid_amount'],
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

  it('refuses bounds that are not an object at all, before reading anything off them', () => {
    // The guard for this ran AFTER the parse, which reads `maxAmountSubunits`
    // off the bounds - so `null` threw on the first read and the guard written
    // for it could only ever fire for a primitive.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      null as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
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

  it('holds MIN_PAY_WINDOW_SECS at the value the gate is written around', () => {
    // Every window row derives its input from the constant, so the comparison
    // was the constant against itself: 119 and 121 both survived. Spelled out,
    // a typo dies - the same reasoning as the protocol-constants row in the
    // logs suite.
    expect(MIN_PAY_WINDOW_SECS).toBe(120);
  });

  it('accepts a request with EXACTLY the minimum window left', () => {
    // The boundary itself: `<` and `<=` both passed the suite, because no row
    // sat on it. A request with exactly the minimum left is payable.
    expect(
      validateTempoPaymentRequest(
        requestJson({ created_at: NOW - (600 - MIN_PAY_WINDOW_SECS) }),
        bounds(),
      ),
    ).toBeNull();
  });

  it('refuses a card whose asset is not an asset, rather than throwing', () => {
    // A discovered card gets its asset from `resolveKnownAsset`, which answers
    // `undefined` for a coin the registry does not carry. With an
    // `expectedAsset` beside it the `??` never fires, so the coin comparison
    // reads `.mint` off nothing - and this function's contract is to refuse.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({
        card: { recipient: RECIPIENT, jobPriceSubunits: 10_000n },
        expectedAsset: USDCE_TEMPO_MAINNET,
      }) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses a payment to the TIP-1022 address registry', () => {
    // The fifth system address. It is not a virtual address, so the schema
    // does not catch it, and a transfer there is gone like any other payment
    // to a precompile.
    const problem = validateTempoPaymentRequest(
      requestJson({ recipient: TEMPO_ADDRESS_REGISTRY }),
      bounds({
        card: {
          recipient: TEMPO_ADDRESS_REGISTRY,
          asset: USDCE_TEMPO_MAINNET,
          jobPriceSubunits: 10_000n,
        },
      }),
    );
    expect(problem?.code).toBe('invalid_recipient_address');
  });

  it.each([
    ['its chain', { chain: Symbol('chain') }],
    ['its token', { token: Symbol('token') }],
  ])('refuses a card whose asset has a non-string %s, rather than throwing', (_label, over) => {
    // `assetKey` interpolates all three fields, so all three are read as
    // strings first - the same "cast past the type" class the mint row covers.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({
        card: {
          recipient: RECIPIENT,
          asset: { ...USDCE_TEMPO_MAINNET, ...over },
          jobPriceSubunits: 10_000n,
        },
      }) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('asset_mismatch');
  });

  it('refuses a card whose mint is not a string, rather than throwing', () => {
    // `assetKey` builds a template string, so a symbol or a null-prototype
    // object there throws - out of a function whose contract is to refuse. An
    // unreadable mint is treated as absent, and the coins then differ.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({
        card: {
          recipient: RECIPIENT,
          asset: { ...USDCE_TEMPO_MAINNET, mint: Symbol('mint') },
          jobPriceSubunits: 10_000n,
        },
      }) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('asset_mismatch');
  });

  it('refuses a card whose asset names a FOREIGN mint on the agreed coin', () => {
    // Every card asset in this file comes from the registry, where the token
    // slug already determines the mint - so the mint half of the comparison
    // never decided anything and could be dropped from the key entirely.
    const impostor = { ...USDCE_TEMPO_MAINNET, mint: `0x20c0${'ab'.repeat(18)}` };
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds({ card: { recipient: RECIPIENT, asset: impostor, jobPriceSubunits: 10_000n } }),
    );
    expect(problem?.code).toBe('asset_mismatch');
  });

  it('accepts a card whose mint is spelled in another case', () => {
    // The last address comparison in this file that was case-sensitive. A card
    // built from an explorer value or `getAddress()` carries a checksummed
    // mint, and refusing it said "agreed to pay usdce, but the request debits
    // usdce" - the same coin, spelled twice.
    const shouted = { ...USDCE_TEMPO_MAINNET, mint: `0x${USDCE.slice(2).toUpperCase()}` };
    expect(
      validateTempoPaymentRequest(
        requestJson(),
        bounds({ card: { recipient: RECIPIENT, asset: shouted, jobPriceSubunits: 10_000n } }),
      ),
    ).toBeNull();
  });

  it.each([
    ['a clock', { nowSecs: Symbol('now') }],
    ['a protocol fee', { protocolFeeBps: Symbol('bps') }],
    ['a session cap', { maxAmountSubunits: Symbol('cap') }],
  ])('refuses %s that cannot even be printed, rather than throwing', (_label, over) => {
    // The guard fired and then the MESSAGE threw: every refusal here
    // interpolates what it refuses, and a symbol in a template is a
    // `TypeError` out of a function whose contract is to refuse. The cap threw
    // one layer further out, inside the parser's bigint comparison.
    const problem = validateTempoPaymentRequest(
      requestJson(),
      bounds(over) as unknown as Parameters<typeof validateTempoPaymentRequest>[1],
    );
    expect(problem?.code).toBe('invalid_bounds');
  });

  it('refuses a treasury spelled 0X, the way the policy check does', () => {
    // The last caller-supplied address this half read by hand.
    expect(
      validateTempoPaymentRequest(
        requestJson({ fee_address: TREASURY, fee_amount: '250' }),
        bounds({ protocolFeeBps: 250, treasury: `0X${TREASURY.slice(2)}` }),
      )?.code,
    ).toBe('fee_address_mismatch');
  });

  it('refuses a card recipient spelled 0X, the way the policy check does', () => {
    // The other half of the same agreement: a card recipient in that spelling
    // used to clear this gate and then be `unreadable` in the policy check.
    expect(
      validateTempoPaymentRequest(
        requestJson(),
        bounds({
          card: {
            recipient: `0X${RECIPIENT.slice(2)}`,
            asset: USDCE_TEMPO_MAINNET,
            jobPriceSubunits: 10_000n,
          },
        }),
      )?.code,
    ).toBe('recipient_mismatch');
  });

  it('refuses a payer spelled 0X, the way the policy check does', () => {
    // The two halves of this gate must accept the same spellings. Lowercasing
    // here while the other side anchors on a literal `0x` let such a payer
    // clear the validator and then fail the policy check for ever.
    expect(
      validateTempoPaymentRequest(requestJson(), bounds({ payer: `0X${PAYER.slice(2)}` }))?.code,
    ).toBe('invalid_bounds');
  });

  it.each([
    ['not an address at all', 'the-customer'],
    ['a virtual address', `0x11223344${'fd'.repeat(10)}556677889900`],
  ])('refuses to pay from %s', (_label, payer) => {
    // The CALLER's own address, so the caller's own code. Telling a customer
    // that the PROVIDER named a bad recipient sends them to another provider
    // for ever, over their own malformed wallet address.
    expect(validateTempoPaymentRequest(requestJson(), bounds({ payer }))?.code).toBe(
      'invalid_bounds',
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
    ['is not an object at all', null],
    ['names no chain to read policies on', { token: USDCE, payer: PAYER, recipient: RECIPIENT }],
  ])('returns a verdict for a check that %s, rather than throwing', async (_label, check) => {
    // The sync half guards its bounds; this half read `check.token` straight
    // into a calldata template and `check.chain.caip2` into a message, so a
    // dropped record or a chain not yet chosen died on a property read in the
    // gate that stands between the customer and a signature.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(
      chain.client,
      check as unknown as Parameters<typeof checkTempoReceivePolicies>[1],
    );
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it.each([
    ['the burn address', `0x${'0'.repeat(40)}`],
    ['the transfer guard', TEMPO_TRANSFER_GUARD],
  ])('refuses %s, which the registry itself calls open', async (_label, destination) => {
    // A protocol address carries no policy, so the registry answers `(1, 0)`
    // for it like any open destination. The sync half refuses these four by
    // name; this half PERMITS money to move and enforced nothing.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: destination,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'provider', reason: 'unreadable' });
  });

  it('refuses an unpayable FEE address, and names the fee leg', async () => {
    // The gate was pinned on the provider leg only: applying it to `legs[0]`
    // alone survived the whole suite, and so did labelling every unreadable
    // verdict `provider`. A treasury misconfigured to the fee sink is the
    // shape this half exists to catch before a signature.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      feeAddress: TEMPO_FEE_SINK,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'fee', reason: 'unreadable' });
  });

  it.each([
    ['a virtual recipient', { recipient: `0X11111111${'fd'.repeat(10)}222222222222` }],
    ['a virtual payer', { payer: `0X11111111${'fd'.repeat(10)}222222222222` }],
    ['an unpayable recipient', { recipient: `0X${TEMPO_FEE_SINK.slice(2)}` }],
  ])('refuses a 0X spelling of %s at the shape gate, before any read', async (_label, over) => {
    // These rows hold the SHAPE gate, and the exact message says so: `0X...`
    // never reaches the alias guard or the unpayable list. That is the point.
    // `isEvmAddressFormat` and `isVirtualEvmAddress` both anchor on a
    // lowercase prefix, so a gate that ACCEPTED this spelling and then carried
    // the raw string would answer `false` from the alias guard for the very
    // same value - which is what the round before this one shipped. The
    // normalization that prevents it is pinned by the row below, not by these.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      ...over,
    });
    expect(verdict).toEqual({
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: 'This policy check was handed something that is not an address.',
    });
    // "Before any read" means all of them: the gate runs ahead of the chain
    // confirmation too, so the client is never touched.
    expect(chain.calls).toEqual([]);
  });

  it('refuses an unpayable destination spelled in another case', async () => {
    // This half takes the CALLER's own values, and a wallet answers EIP-55 -
    // there is a row for that. So the gate's own lowercasing is load-bearing
    // here in a way it is not in the sync half, where the schema has already
    // forced the spelling.
    const chain = answering({});
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: `0x${TEMPO_TRANSFER_GUARD.slice(2).toUpperCase()}`,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'provider', reason: 'unreadable' });
  });

  it('names the FEE leg when the fee leg is the one that cannot be read', async () => {
    // The loop's own `leg` label was unpinned too: replacing it with the
    // constant `provider` survived.
    const chain = answering({ [TREASURY]: '0x' });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
      feeAddress: TREASURY,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'fee', reason: 'unreadable' });
  });

  it('returns a verdict when the provider throws SYNCHRONOUSLY, rather than rejecting', async () => {
    // A `.catch` on the promise never sees a provider that validates params
    // before there is a promise - a browser wallet or a proxy - and the throw
    // escaped a function whose whole contract is to answer with a verdict.
    const chain = answering({});
    const throwing = {
      request(args: { method: string }) {
        if (args.method === 'eth_call') {
          throw new Error('provider rejected the call synchronously');
        }
        return chain.client.request(args as Parameters<typeof chain.client.request>[0]);
      },
    } as unknown as typeof chain.client;
    const verdict = await checkTempoReceivePolicies(throwing, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('reads a first word that is neither 0 nor 1 as unreadable, not as a refusal', async () => {
    // A future flag, or another contract at this address. Calling it `blocked`
    // tells the operator to ask that destination to open its policy - an
    // actionable instruction about an answer nobody could parse.
    const chain = answering({ [RECIPIENT]: `0x${'2'.padStart(64, '0')}${'0'.repeat(64)}` });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false, leg: 'provider', reason: 'unreadable' });
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

  it('refuses a policy answer whose first word is neither 0 nor 1', async () => {
    // The word is a flag and only `1` is permission. Pinned against zero only,
    // a registry answering 2 - a future flag, a different contract at the same
    // address - would read as a yes and the money would move.
    const chain = answering({
      [RECIPIENT]: `0x${'2'.padStart(64, '0')}${'0'.repeat(64)}`,
    });
    const verdict = await checkTempoReceivePolicies(chain.client, {
      chain: CHAINS.TEMPO_MAINNET,
      token: USDCE,
      payer: PAYER,
      recipient: RECIPIENT,
    });
    expect(verdict).toMatchObject({ ok: false });
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
  const BLOCKED_ORIGINATOR_WORD = 7;

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
      ...options,
      // The blocks the recorded receipts sit in are readable by default, the
      // way a real endpoint holding them would answer: a receipt is bound to
      // the block this chain holds at its height before any verdict rests on
      // it, so a row that wants the default path must be able to show it. A
      // row that passes its own timestamp still wins - the spread is last.
      timestamps: {
        40_000_000: NOW,
        [BATCH_BLOCK]: NOW,
        [BLOCKED_BLOCK]: NOW,
        ...options.timestamps,
      },
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

  /** One `TransferWithMemo` to `to`, as a node would list it. */
  function memoLogOf(to: string, memo: string, amount: bigint, blockNumber: number): FakeLog {
    return {
      address: USDCE,
      topics: [TRANSFER_WITH_MEMO_TOPIC, topicWord(PAYER), topicWord(to), memo],
      data: `0x${amount.toString(16).padStart(64, '0')}`,
      blockNumber,
      transactionHash: `0x${'e7'.repeat(32)}`,
      logIndex: 0,
    };
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

  it('credits a memo leg PAID BY A STRANGER, and for MORE than it asked', async () => {
    // Two deliberate leniencies, both rules this rail states out loud and
    // neither held by anything: a leg found by memo counts as done whoever
    // paid it (a relayer, a batcher, a friend), and a transfer that covers the
    // amount covers it. Making either strict passed the whole suite.
    const stranger = `0x${'5c'.repeat(20)}`;
    const generous = (BATCH.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_WITH_MEMO_TOPIC &&
      (log.topics as string[])[3] === BATCH_MEMO
        ? {
            ...log,
            topics: [
              (log.topics as string[])[0],
              topicWord(stranger),
              (log.topics as string[])[2],
              (log.topics as string[])[3],
            ],
            data: `0x${25_000n.toString(16).padStart(64, '0')}`,
          }
        : log,
    );
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: generous } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, [legs[0]], {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toMatchObject({ state: 'delivered' });
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

  it('holds the protocol addresses the chain actually uses', () => {
    // Both constants survived a one-nibble mutation because every row that
    // touches them imports them - so the rows compared a value with itself.
    // Spelled out here, and checked against a RECORDED receipt where one of
    // them appears on the wire, a typo in either dies.
    expect(TEMPO_FEE_SINK).toBe('0xfeec000000000000000000000000000000000000');
    expect(TEMPO_POLICY_REGISTRY).toBe('0x403c000000000000000000000000000000000000');
    // The fifth unpayable address, added after the constant shipped with the
    // same self-comparing shape: one nibble off and the TIP-1022 registry is
    // payable again in both halves of the validator.
    expect(TEMPO_ADDRESS_REGISTRY).toBe('0xfdc0000000000000000000000000000000000000');
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
    // The deadline floor, by value: every row that feeds it derives its input
    // from the constant, so dropping it ten-fold left the suite green while
    // its twin ceiling was pinned by the milliseconds row.
    expect(EARLIEST_TEMPO_SECONDS).toBe(1_600_000_000);
    expect(LATEST_TEMPO_SECONDS).toBe(7_258_118_400);
    const gasLog = receiptLogs(BATCH).find(
      (log) => log.topics[0] === TRANSFER_TOPIC && log.topics[2]?.endsWith(TEMPO_FEE_SINK.slice(2)),
    );
    expect(gasLog).toBeDefined();
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
    // What the verdict CARRIES, not only how many of them. Rewriting every
    // credited amount to zero passed this row while it counted alone, and 3b
    // reports these legs to a customer: the amount, the destination and the
    // memo are the answer to "what did I actually pay for".
    const credited = outcome.state === 'delivered' ? outcome.legs : [];
    expect(credited).toHaveLength(2);
    expect(credited.map((leg) => [leg.to, leg.amount, leg.memo])).toEqual([
      [RECIPIENT, 10_000n, BATCH_MEMO],
      [TREASURY, 10_000n, BATCH_MEMO],
    ]);
    // Each leg comes off a distinct log HERE, because the two name different
    // destinations and no source change could make them share one. It does NOT
    // pin the rule P44 records - two legs to ONE destination are still both
    // satisfied by a single log - and claiming it did was the row saying more
    // than it holds. P44 is triaged to 2b-ii-b with the leg set it needs.
    expect(new Set(credited.map((leg) => leg.logIndex)).size).toBe(2);
    for (const leg of credited) {
      expect(leg.transactionHash).toBe(BATCH_HASH);
    }
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

  it.each([
    ['a block this endpoint cannot show', undefined],
    ['a block whose hash is another chain’s', `0x${'ad'.repeat(32)}`],
  ])('credits nothing off a receipt bound to %s', async (_label, blockHash) => {
    // A hash binds a receipt to a transaction, not to a network. The two Tempo
    // chains share the token, the guard and the registry addresses and their
    // heights overlap, so a split endpoint can answer with a receipt that is
    // perfectly real somewhere else. `verify.ts` has bound its reads this way
    // since 2b-i; the sender's side is the more expensive one to get wrong,
    // because its terminal verdict is what invites a replacement.
    const chain = chainWith({
      receipts: { [BATCH_HASH]: BATCH },
      ...(blockHash === undefined
        ? { timestamps: { 40_000_000: NOW, [BATCH_BLOCK]: undefined } }
        : { blockHashes: { [BATCH_BLOCK]: blockHash } }),
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('credits nothing off a receipt whose LOGS name another block', async () => {
    // The receipt is bound to the chain; its logs arrive inside it and were
    // bound only by block NUMBER, which two chains can share. `verify.ts`
    // compares a scanned leg's `blockHash`, so this is the third reader of one
    // rule - and it was the reader without it.
    const foreignLogs = (BATCH.logs as Record<string, unknown>[]).map((log) => ({
      ...log,
      blockHash: `0x${'ad'.repeat(32)}`,
    }));
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: foreignLogs } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('does not call a receipt DELIVERED when its BLOCK could not be read', async () => {
    // The sibling of the unreadable-`status` row, on the field the chain bind
    // now leans on: a number where the wire says hex is a shape a real backend
    // answers, and it is not evidence of anything.
    const chain = chainWith({
      receipts: { [BATCH_HASH]: { ...BATCH, blockNumber: 'not-a-block' } },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('refuses a leg pointed back at its own sender, rather than reading one', async () => {
    // `from == to` moves nothing, and the two halves of this rail read such a
    // log differently: the scan drops it, a receipt carries it. Left to the
    // verdicts, the same self-transfer would be `delivered` from its receipt
    // and `unsent` from the absence proof - and `unsent` invites a
    // replacement. So it is refused where the caller can see it.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    await expect(
      resolveTempoTransferOutcome(
        chain.client,
        [{ token: USDCE, from: PAYER, to: PAYER, amount: 10_000n }],
        {
          chain: CHAINS.TEMPO_MAINNET,
          hash: BATCH_HASH,
          floor: BATCH_BLOCK - 100,
          validBefore: NOW + 60,
        },
      ),
    ).rejects.toThrow(/move between two addresses/);
  });

  it('does not read a stranger-originated guard log as OUR withdrawal', async () => {
    // A memo-less leg has no memo to bind it, so the guard log's originator is
    // the whole binding - and the rule was pinned in one direction only:
    // forcing the comparison to `true` passed the suite. A stranger's block on
    // the same token and receiver would then answer for our withdrawal, and
    // the sender would sit at `pending` instead of reaching `unsent`.
    const guardFromStranger = (BLOCKED.logs as Record<string, unknown>[]).map((log) =>
      (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC
        ? withDataWord(log, BLOCKED_ORIGINATOR_WORD, `${'0'.repeat(24)}${'ab'.repeat(20)}`)
        : log,
    );
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs: guardFromStranger } },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [
        {
          token: PATHUSD,
          from: BLOCKED_LEG.from,
          to: BLOCKED_LEG.to,
          amount: BLOCKED_LEG.amount,
        },
      ],
      {
        chain: CHAINS.TEMPO_DEVNET,
        hash: BLOCKED_HASH,
        floor: BLOCKED_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome.state).toBe('pending');
    // The control its two siblings carry: the unmodified guard log on the same
    // chain object IS read as ours, so `pending` above is the rule refusing a
    // stranger's log and not a receipt path that read nothing.
    const pristine = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    expect(
      (
        await resolveTempoTransferOutcome(pristine.client, [BLOCKED_LEG], {
          chain: CHAINS.TEMPO_DEVNET,
          hash: BLOCKED_HASH,
          floor: BLOCKED_BLOCK - 100,
          validBefore: NOW + 60,
        })
      ).state,
    ).toBe('blocked');
  });

  it('does not read a GUARD log from another block as our blocked leg', async () => {
    // The guard pass decides the more expensive verdict - `blocked` tells the
    // sender its money is parked, and 4a's withdraw reports that as not sent -
    // and it runs BEFORE the delivered match, so an unbound guard log wins
    // over a receipt that really did deliver. Height alone is a value the two
    // Tempo networks share.
    const guardElsewhere = (BLOCKED.logs as Record<string, unknown>[])
      .filter((log) => (log.topics as string[])[0] === TRANSFER_BLOCKED_TOPIC)
      .map((log) => ({
        ...log,
        transactionHash: BLOCKED_HASH,
        blockHash: `0x${'ad'.repeat(32)}`,
      }));
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs: guardElsewhere } },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome.state).toBe('pending');
  });

  it.each([
    ['eth_getTransactionReceipt', 'eth_getTransactionReceipt'],
    ['eth_getBlockByNumber', 'eth_getBlockByNumber'],
  ])('answers pending when the provider throws SYNCHRONOUSLY from %s', async (_label, method) => {
    // A `.catch` on the promise never sees a provider that validates its
    // params first - a browser wallet, a proxy - and this function's header
    // promises that every rpc failure is `pending`, not a rejection the caller
    // has to know about.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    const throwing = {
      request(args: { method: string }) {
        if (args.method === method) {
          throw new Error('provider rejected the call synchronously');
        }
        return chain.client.request(args as Parameters<typeof chain.client.request>[0]);
      },
    } as unknown as typeof chain.client;
    const outcome = await resolveTempoTransferOutcome(throwing, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('will not call a REVERTED receipt unsent until it is bound to this chain', async () => {
    // The revert branch is terminal too, and it is the one that says a
    // replacement is safe: somebody else's failed receipt, answered by a split
    // endpoint, would send the money twice.
    const chain = chainWith({
      receipts: { [BATCH_HASH]: { ...BATCH, status: '0x0' } },
      blockHashes: { [BATCH_BLOCK]: `0x${'ad'.repeat(32)}` },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it.each([
    ['blocked', 'blocked'],
    ['reverted', 'unsent'],
  ])('asks the chain again before a %s verdict too', async (label, expected) => {
    // The ask is one state-agnostic condition, so narrowing it to `delivered`
    // alone passed the suite. These two rows hold the other states it covers.
    const receipt = label === 'reverted' ? { ...BLOCKED, status: '0x0' } : BLOCKED;
    const chain = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: receipt },
    });
    let seenReceipt = false;
    const switching = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId' && seenReceipt) {
          return '0x1079';
        }
        const answer = await chain.client.request(
          args as Parameters<typeof chain.client.request>[0],
        );
        if (args.method === 'eth_getTransactionReceipt') {
          seenReceipt = true;
        }
        return answer;
      },
    } as unknown as typeof chain.client;
    const options = {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    };
    // The control: on a chain that does not move, this receipt really does
    // reach the terminal verdict this row is about.
    expect((await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], options)).state).toBe(
      expected,
    );
    expect(await resolveTempoTransferOutcome(switching, [BLOCKED_LEG], options)).toEqual({
      state: 'pending',
    });
  });

  it('asks the chain again before a verdict read off a receipt', async () => {
    // The absence path ends with this ask and the provider's verifier makes it
    // before every terminal answer; the receipt path made it only at the
    // start. A gateway that fails over, or a wallet whose user switches
    // network mid-call, would otherwise hand back a terminal verdict about
    // another network's chain.
    const chain = chainWith({ receipts: { [BATCH_HASH]: BATCH } });
    let seenReceipt = false;
    const switching = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_chainId' && seenReceipt) {
          return '0xa5bf';
        }
        const answer = await chain.client.request(
          args as Parameters<typeof chain.client.request>[0],
        );
        if (args.method === 'eth_getTransactionReceipt') {
          seenReceipt = true;
        }
        return answer;
      },
    } as unknown as typeof chain.client;
    const outcome = await resolveTempoTransferOutcome(switching, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome).toEqual({ state: 'pending' });
  });

  it('does not credit a memo log whose sender IS its destination', async () => {
    // `from == to` proves nothing: an infinite allowance is never decremented,
    // so `transferFromWithMemo(from = X, to = X)` is a free full-amount memo
    // log for anyone holding X's allowance. The scan drops such an entry and
    // the provider refuses it; the receipt path is the third reader of this
    // log class, and it held the rule nowhere.
    const selfAddressed = (BATCH.logs as Record<string, unknown>[]).map((log) => {
      const topics = log.topics as string[];
      return topics[0] === TRANSFER_WITH_MEMO_TOPIC
        ? { ...log, topics: [topics[0], topics[2], topics[2], topics[3]] }
        : log;
    });
    const chain = chainWith({ receipts: { [BATCH_HASH]: { ...BATCH, logs: selfAddressed } } });
    const outcome = await resolveTempoTransferOutcome(chain.client, legs, {
      chain: CHAINS.TEMPO_MAINNET,
      hash: BATCH_HASH,
      floor: BATCH_BLOCK - 100,
      validBefore: NOW + 60,
    });
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
    expect(outcome.state).toBe('pending');
    // A control on the same chain object, because `pending` is also what a
    // receipt that was never read answers: without it this row would stay
    // green if the receipt path broke entirely. The unmodified leg is blocked
    // here, so the setup is live and the difference is the rule under test.
    expect(
      (
        await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
          chain: CHAINS.TEMPO_DEVNET,
          hash: BLOCKED_HASH,
          floor: BLOCKED_BLOCK - 100,
          validBefore: NOW + 60,
        })
      ).state,
    ).toBe('blocked');
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: { ...BLOCKED, logs } },
    });
    const outcome = await resolveTempoTransferOutcome(chain.client, [BLOCKED_LEG], {
      chain: CHAINS.TEMPO_DEVNET,
      hash: BLOCKED_HASH,
      floor: BLOCKED_BLOCK - 100,
      validBefore: NOW + 60,
    });
    expect(outcome.state).toBe('pending');
    // The same control, against the untouched receipt: a guard log this rail
    // DOES read as ours, on a chain built the same way. `pending` here would
    // otherwise be indistinguishable from a receipt path that read nothing.
    const pristine = fakeTempoChain({
      chainId: '0xa5bf',
      finalized: 35_790_000,
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
      receipts: { [BLOCKED_HASH]: BLOCKED },
    });
    expect(
      (
        await resolveTempoTransferOutcome(pristine.client, [BLOCKED_LEG], {
          chain: CHAINS.TEMPO_DEVNET,
          hash: BLOCKED_HASH,
          floor: BLOCKED_BLOCK - 100,
          validBefore: NOW + 60,
        })
      ).state,
    ).toBe('blocked');
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

  it('proves a withdrawal absent about OUR sender, not anyone who paid that address', async () => {
    // The memo-less scan filters on `from`, and that filter had no row: a
    // memo leg is paid by anyone, a withdrawal is not. Somebody else's
    // transfer to the same destination in the same window is not evidence
    // about ours, and without the filter it would turn `unsent` into
    // `pending` for ever.
    const stranger = memoLogOf(RECIPIENT, `0x${'11'.repeat(32)}`, 696n, 39_999_950);
    const chain = chainWith({
      receipts: {},
      logs: [
        ...history(PATHUSD, BATCH_BLOCK - 100, 40_000_000),
        {
          ...stranger,
          address: PATHUSD,
          topics: [TRANSFER_TOPIC, topicWord(`0x${'ab'.repeat(20)}`), topicWord(RECIPIENT)],
        },
      ],
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: RECIPIENT, amount: 696n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'unsent', reason: 'deadline_passed' });
  });

  it('proves a WITHDRAWAL never went out, not only a payment', async () => {
    // Every other `unsent` row uses the two memo legs, so the memo-LESS half
    // of the virtual-address guard could be widened from `&&` to `||` and the
    // suite stayed green - which would make every withdrawal `pending` for
    // ever, and 4a could never tell its user the money never left.
    const chain = chainWith({
      receipts: {},
      logs: history(PATHUSD, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: PATHUSD, from: PAYER, to: RECIPIENT, amount: 696n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'unsent', reason: 'deadline_passed' });
  });

  it.each([
    ['the transfer pass', TRANSFER_WITH_MEMO_TOPIC],
    ['the guard pass', TRANSFER_BLOCKED_TOPIC],
  ])(
    'proves the absence up to the block it READ, not one a second read answers, on %s',
    async (_label, topic) => {
      // `provenUnsent` reads `finalized` once and hands that number to both
      // passes as their ceiling. Both scans take `toBlock` as optional and
      // default it to "the finalized number read now", so dropping either line
      // reads as redundant - and costs the customer the payment. A second read
      // can land on a lagging backend behind the same load balancer that
      // accepted the broadcast, which is the actor this file's own header
      // names. Then the pass never looks at the blocks between the two heads,
      // comes back complete and empty, and answers `unsent`: send it again.
      const lagging = 39_999_000;
      const inTheGap = 39_999_500;
      const parked = guardLogsOf(BLOCKED).map((log) => ({
        ...log,
        blockNumber: inTheGap,
        topics: [
          TRANSFER_BLOCKED_TOPIC,
          topicWord(USDCE),
          topicWord(RECIPIENT),
          ...(log.topics as string[]).slice(3),
        ],
      }));
      const evidence =
        topic === TRANSFER_WITH_MEMO_TOPIC
          ? [memoLogOf(RECIPIENT, BATCH_MEMO, 10_000n, inTheGap)]
          : parked;
      const base = chainWith({
        receipts: {},
        logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), ...evidence],
        timestamps: { 40_000_000: NOW + 600, [lagging]: NOW + 600 },
      });
      let heads = 0;
      const drifting = {
        request: async (args: { method: string; params?: readonly unknown[] }) => {
          if (args.method === 'eth_getBlockByNumber' && args.params?.[0] === 'finalized') {
            heads += 1;
            if (heads > 1) {
              // A well-formed head, just an older one - otherwise the scan
              // answers "incomplete" and the ceiling is never under test.
              return {
                number: `0x${lagging.toString(16)}`,
                timestamp: `0x${(NOW + 600).toString(16)}`,
                hash: `0x${'5a'.repeat(32)}`,
              };
            }
          }
          return base.client.request(args);
        },
      };
      const outcome = await resolveTempoTransferOutcome(drifting, [legs[0]], {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      });
      expect(outcome).toEqual({ state: 'pending' });
      // One read, handed to both passes: a second would be a second answer.
      expect(heads).toBe(1);
    },
  );

  it('still says UNSENT with a stranger’s memo and a SMALLER transfer in the window', async () => {
    // Two decoys the scan must not count, both to our own destinations. One
    // carries somebody else's memo - the memo is what binds a transfer to this
    // request, and the filter is what enforces that. One carries OUR memo at
    // less than the amount - a transfer below `minAmount` is DROPPED, and a
    // drop leaves the pass complete, so `unsent` still stands. (The plan used
    // to claim any transfer could only turn `unsent` into `pending`; round 13
    // measured otherwise and the sentence was corrected.)
    const theirs = memoLogOf(RECIPIENT, `0x${'7a'.repeat(32)}`, 10_000n, BATCH_BLOCK - 40);
    const tooSmall = memoLogOf(RECIPIENT, BATCH_MEMO, 9_999n, BATCH_BLOCK - 30);
    const chain = chainWith({
      receipts: {},
      logs: [...history(USDCE, BATCH_BLOCK - 100, 40_000_000), theirs, tooSmall],
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

  it('refuses a HEAD that is a number but not a time, however far past the deadline', async () => {
    // The mirror of "refuses a deadline of %s, which is a number but not a
    // time", on the other operand. Tempo counts in milliseconds internally, so
    // an endpoint answering a millisecond `timestamp` is one translation away
    // - and it clears every deadline at once. The scan below is then honestly
    // empty, because the transaction is still in the mempool, and calling that
    // `unsent` invites the replacement that pays twice.
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW * 1000 },
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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

  it('will not prove the absence of a WITHDRAWAL to a virtual destination', async () => {
    // The sibling half of this line has its own row and this one did not. A
    // withdrawal to a TIP-1022 alias whose transfer the MASTER's policy
    // blocked: the guard files `TransferBlocked` under the master, so a guard
    // pass filtered on the alias finds nothing; a blocked transfer emits no
    // `Transfer`, so that pass is complete and empty; the history control
    // passes. Everything lines up for `unsent` - send it again - on 25000000
    // subunits already parked with the guard and recoverable only by the
    // master's recovery authority.
    // Four bytes, then the ten 0xfd TIP-1022 marks, then six. This one is
    // real: the 2b-i census found 92 guard logs naming it on Moderato.
    const alias = '0xb385a519fdfdfdfdfdfdfdfdfdfd000000000001';
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const outcome = await resolveTempoTransferOutcome(
      chain.client,
      [{ token: USDCE, from: PAYER, to: alias, amount: 25_000_000n }],
      {
        chain: CHAINS.TEMPO_MAINNET,
        hash: BATCH_HASH,
        floor: BATCH_BLOCK - 100,
        validBefore: NOW + 60,
      },
    );
    expect(outcome).toEqual({ state: 'pending' });
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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

  it('stops after the first scan chunk when the signal fires during it', async () => {
    // The sibling above aborts before any scan runs; this one aborts DURING
    // the first chunk, so it pins that the scan itself takes the signal rather
    // than only the reads before it. The guard pass and the two history
    // controls take it too, but an abort can never be observed there: the
    // scan that aborted returns incomplete and `provenUnsent` answers
    // `pending` before the next read starts (recorded as P55).
    const controller = new AbortController();
    const chain = chainWith({
      receipts: {},
      logs: history(USDCE, BATCH_BLOCK - 100, 40_000_000),
      timestamps: { 40_000_000: NOW + 600 },
    });
    const client = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        const answer = await chain.client.request(args);
        if (args.method === 'eth_getLogs') {
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
    // One chunk, and then nothing: no guard pass, no control, no second leg.
    expect(chain.getLogsCalls).toHaveLength(1);
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
    // Every read on THIS path takes the caller's signal. Without them an
    // abandoned resolve keeps issuing up to 512 log queries per leg plus the
    // control's. The receipt path's chain bind does not take one - it goes
    // through `readBlockByNumber`, which P16 already names as unwrapped.
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
      timestamps: { 35_790_000: NOW, [BLOCKED_BLOCK]: NOW },
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
