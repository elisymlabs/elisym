import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  type OrderPaidWebhookEvent,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
  type WebhookHeaders,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_MIN_SECRET_BYTES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECS,
  signWebhook,
  verifyWebhook,
} from '../src/webhook';
import { equalBytes } from '../src/webhook/crypto';

const SECRET = 'x'.repeat(32);
const OTHER_SECRET = 'y'.repeat(32);
const TS = 1_791_100_000;
const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const EVENT_ID = 'c'.repeat(64);
const PRODUCT = `30402:${STORE}:course-101`;
const USDC_DEVNET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

/** T1: the golden vector shared with the node (`merchant-node/tests/webhook.test.ts`). */
const GOLDEN_1 = 'v1=3c8a1c2fe10d3b2f9f419de45b1a81e4ef90265bcf45dd734dc99989fde5ac99';
/** T2: a non-ASCII secret and body (a lone surrogate included), recorded from `createHmac`. */
const GOLDEN_2_SECRET = 'é'.repeat(16);
const GOLDEN_2_BODY = '{"note":"€ 🎉 \uD800"}';
const GOLDEN_2 = 'v1=c48a492c1e01c179c02f25597d1011fa2cad17e38e94994ccd2927d985bccbc3';

/** Every field the node can send, optionals included, in the node's key order. */
const ORDER_PAID: OrderPaidWebhookEvent = {
  event: 'order.paid',
  eventId: EVENT_ID,
  store: STORE,
  orderId: 'b3a7c2d4-0000-4000-8000-000000000001',
  buyerPubkey: BUYER,
  customerRef: 'user-123',
  product: { address: PRODUCT },
  payment: {
    asset: USDC_DEVNET,
    amount: '1500000',
    amountDisplay: '1.5',
    decimals: 6,
    symbol: 'USDC',
    tx: SIG,
    medium: 'solana-devnet',
    paidAt: TS - 880,
  },
  email: 'buyer@example.com',
};
const ORDER_PAID_BODY = JSON.stringify(ORDER_PAID);
const ENCODER = new TextEncoder();

/** Independent of the code under test: HMAC over any timestamp text and raw bytes. */
function rawSign(secret: string, timestampText: string, body: Uint8Array): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`${timestampText}.`, 'utf8'))
    .update(body)
    .digest('hex');
  return `v1=${mac}`;
}

function sign(body: string, timestamp = TS, secret = SECRET): string {
  return rawSign(secret, String(timestamp), ENCODER.encode(body));
}

function nodeHeaders(signature: string, timestamp: number | string = TS): IncomingHttpHeaders {
  return {
    'x-elisym-signature': signature,
    'x-elisym-timestamp': String(timestamp),
  };
}

function verifyAt(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  extra: Partial<VerifyWebhookInput> = {},
): Promise<VerifyWebhookResult> {
  return verifyWebhook({ secret: SECRET, body, headers, now: TS, ...extra });
}

async function reasonOf(promise: Promise<VerifyWebhookResult>): Promise<string> {
  const result = await promise;
  return result.ok ? 'ok' : result.reason;
}

/** A signed, fresh body: its result. */
function signedReason(body: string): Promise<string> {
  return reasonOf(verifyAt(body, nodeHeaders(sign(body))));
}

const REMOVE = Symbol('remove');

/** The full `order.paid` with one field (by path) replaced or removed, as JSON. */
function orderPaidWith(path: readonly string[], value: unknown): string {
  const body = JSON.parse(ORDER_PAID_BODY) as Record<string, unknown>;
  let parent: Record<string, unknown> = body;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1] ?? '';
  if (value === REMOVE) {
    delete parent[last];
  } else {
    parent[last] = value;
  }
  return JSON.stringify(body);
}

function goodHex(body = ORDER_PAID_BODY): string {
  return sign(body).slice('v1='.length);
}

/** The hex with the char at `index` XOR 8: for an even index, only the byte's high bit differs. */
function hexWithBit3Flipped(hex: string, index: number): string {
  const flipped = (Number.parseInt(hex.charAt(index), 16) ^ 8).toString(16);
  return `${hex.slice(0, index)}${flipped}${hex.slice(index + 1)}`;
}

describe('equalBytes', () => {
  it('compares every byte and every bit', () => {
    const base = Uint8Array.from({ length: 32 }, (_unused, index) => (index * 37) & 0xff);
    expect(equalBytes(base, Uint8Array.from(base))).toBe(true);
    expect(equalBytes(base, base.subarray(1))).toBe(false);
    for (let position = 0; position < base.length; position += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const changed = Uint8Array.from(base);
        changed[position] = (changed[position] ?? 0) ^ (1 << bit);
        expect(`${position}/${bit}: ${equalBytes(base, changed)}`).toBe(
          `${position}/${bit}: false`,
        );
      }
    }
  });

  it('refuses a prefix of either side', () => {
    expect(equalBytes(Uint8Array.of(1, 0), Uint8Array.of(1))).toBe(false);
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });
});

describe('signWebhook', () => {
  it('T1: matches the node golden vector, and the independent HMAC', async () => {
    expect(await signWebhook({ secret: SECRET, timestamp: TS, body: '{"a":1}' })).toBe(GOLDEN_1);
    expect(rawSign(SECRET, String(TS), ENCODER.encode('{"a":1}'))).toBe(GOLDEN_1);
  });

  it('T1b: signs the body verbatim, edge whitespace included', async () => {
    const body = ' {"a":1}\n';
    expect(await signWebhook({ secret: SECRET, timestamp: TS, body })).toBe(
      rawSign(SECRET, String(TS), ENCODER.encode(body)),
    );
  });

  it('T1c: signs and verifies a string body verbatim, never Unicode-normalized', async () => {
    const body = `{"event":"test","eventId":"${EVENT_ID}","store":"${STORE}","email":"jose\u0301@example.com"}`;
    expect(body.normalize()).not.toBe(body);
    expect(await signWebhook({ secret: SECRET, timestamp: TS, body })).toBe(sign(body));
    expect(await signedReason(body)).toBe('ok');
  });

  it('T2: matches createHmac for a non-ASCII secret and body, lone surrogate included', async () => {
    expect(
      await signWebhook({
        secret: GOLDEN_2_SECRET,
        timestamp: TS,
        body: GOLDEN_2_BODY,
      }),
    ).toBe(GOLDEN_2);
    const nodeMac = createHmac('sha256', Buffer.from(GOLDEN_2_SECRET, 'utf8'))
      .update(`${TS}.${GOLDEN_2_BODY}`, 'utf8')
      .digest('hex');
    expect(`v1=${nodeMac}`).toBe(GOLDEN_2);
    // 16 characters, 32 bytes: long enough on both sides.
    const result = await verifyWebhook({
      secret: GOLDEN_2_SECRET,
      body: '{"event":"test","eventId":"' + EVENT_ID + '","store":"' + STORE + '"}',
      headers: nodeHeaders(
        await signWebhook({
          secret: GOLDEN_2_SECRET,
          timestamp: TS,
          body: '{"event":"test","eventId":"' + EVENT_ID + '","store":"' + STORE + '"}',
        }),
      ),
      now: TS,
    });
    expect(result.ok).toBe(true);
  });

  it('signs at timestamp 0, the lowest one allowed', async () => {
    const nodeMac = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update('0.{}', 'utf8')
      .digest('hex');
    expect(await signWebhook({ secret: SECRET, timestamp: 0, body: '{}' })).toBe(`v1=${nodeMac}`);
  });
});

describe('verifyWebhook', () => {
  it('T3: verifies a full order.paid with every kind of headers object', async () => {
    const signature = await signWebhook({
      secret: SECRET,
      timestamp: TS,
      body: ORDER_PAID_BODY,
    });
    const plain = nodeHeaders(signature);
    const askedFor: string[] = [];
    const getter = {
      get(name: string): string | undefined {
        askedFor.push(name);
        return name === 'x-elisym-signature'
          ? signature
          : name === 'x-elisym-timestamp'
            ? String(TS)
            : undefined;
      },
    };
    const shapes: WebhookHeaders[] = [
      new Headers({
        'X-Elisym-Signature': signature,
        'X-Elisym-Timestamp': String(TS),
      }),
      plain,
      { 'X-Elisym-Signature': signature, 'x-ELISYM-timestamp': String(TS) },
      { 'x-elisym-signature': [signature], 'x-elisym-timestamp': [String(TS)] },
      new Map(
        Object.entries({
          'x-elisym-signature': signature,
          'x-elisym-timestamp': `${TS}`,
        }),
      ),
      getter,
      {
        'x-elisym-signature': signature,
        'x-elisym-timestamp': undefined,
        'X-Elisym-Timestamp': `${TS}`,
      },
      // A sender can add a `Get: x` header: a string `get` is a header, not a getter.
      {
        get: 'x',
        'x-elisym-signature': signature,
        'x-elisym-timestamp': String(TS),
      },
      {
        'x-elisym-signature': signature,
        'x-elisym-timestamp': [undefined, String(TS)] as unknown as readonly string[],
      },
    ];
    for (const headers of shapes) {
      expect(await verifyAt(ORDER_PAID_BODY, headers)).toEqual({
        ok: true,
        event: ORDER_PAID,
      });
    }
    expect(askedFor.length).toBeGreaterThan(0);
    expect(askedFor.every((name) => name === name.toLowerCase())).toBe(true);
  });

  it('T4: takes the body as bytes, an offset view, a Buffer and a cross-realm array', async () => {
    const bytes = ENCODER.encode(ORDER_PAID_BODY);
    const headers = nodeHeaders(sign(ORDER_PAID_BODY));
    const expected = { ok: true, event: ORDER_PAID };
    expect(await verifyAt(bytes, headers)).toEqual(expected);
    const offset = 7;
    const backing = new Uint8Array(offset + bytes.length);
    backing.set(ENCODER.encode('garbage'), 0);
    backing.set(bytes, offset);
    expect(await verifyAt(backing.subarray(offset), headers)).toEqual(expected);
    expect(await verifyAt(Buffer.from(bytes), headers)).toEqual(expected);
    const foreign: Uint8Array = runInNewContext(`new Uint8Array([${bytes.join(',')}])`);
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(await verifyAt(foreign, headers)).toEqual(expected);
  });

  it('T5: gives bad_signature for every broken signature or timestamp', async () => {
    const body = ORDER_PAID_BODY;
    const good = sign(body);
    const hex = goodHex();
    const flipped = ENCODER.encode(body);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    const lastChanged = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    const cases: [string, string | Uint8Array, WebhookHeaders][] = [
      ['wrong secret', body, nodeHeaders(sign(body, TS, OTHER_SECRET))],
      ['bit flipped in the body', flipped, nodeHeaders(good)],
      ['last hex char changed', body, nodeHeaders(lastChanged)],
      [
        'first hex char XOR 8 (high bit of byte 0)',
        body,
        nodeHeaders(`v1=${hexWithBit3Flipped(hex, 0)}`),
      ],
      ['v1 entry behind a v2= prefix', body, nodeHeaders(`v2=${good}`)],
      ['v1 entry behind a stray char', body, nodeHeaders(`x${good}`)],
      [
        'timestamp with an edge space, signed over the trimmed text',
        body,
        nodeHeaders(good, ` ${TS}`),
      ],
      ['timestamp changed by 1', body, nodeHeaders(good, TS + 1)],
      ['signature missing', body, { 'x-elisym-timestamp': String(TS) }],
      ['timestamp missing', body, { 'x-elisym-signature': good }],
      [
        'timestamp getter undefined',
        body,
        {
          get: (name: string) => (name === 'x-elisym-signature' ? good : undefined),
        },
      ],
      ['bare hex', body, nodeHeaders(hex)],
      ['v0 only', body, nodeHeaders(`v0=${hex}`)],
      ['v2 only', body, nodeHeaders(`v2=${hex}`)],
      ['uppercase V1 prefix', body, nodeHeaders(`V1=${hex}`)],
      ['63 hex', body, nodeHeaders(`v1=${hex.slice(1)}`)],
      ['65 hex', body, nodeHeaders(`v1=${hex}0`)],
      ['empty v1', body, nodeHeaders('v1=')],
      ['non-hex', body, nodeHeaders(`v1=${hex.slice(0, -1)}g`)],
      [
        '9 entries, good last',
        body,
        nodeHeaders([...Array.from({ length: 8 }, () => 'v2=x'), good].join(',')),
      ],
      ['empty list', body, nodeHeaders(' , ')],
      [
        'two timestamp values',
        body,
        {
          'x-elisym-signature': good,
          'x-elisym-timestamp': [String(TS), String(TS)],
        },
      ],
      [
        'two case-variant timestamp keys, the signed one first',
        body,
        {
          'x-elisym-signature': good,
          'x-elisym-timestamp': String(TS),
          'X-Elisym-Timestamp': String(TS + 1),
        },
      ],
    ];
    for (const [name, caseBody, headers] of cases) {
      expect(`${name}: ${await reasonOf(verifyAt(caseBody, headers))}`).toBe(
        `${name}: bad_signature`,
      );
    }
    // Odd timestamp text, each signed over its own text: only the format check refuses it.
    for (const text of [
      '+1791100000',
      '1791100000.0',
      ' 1791100000',
      '01791100000',
      '-1',
      '1000000000000',
    ]) {
      const signature = rawSign(SECRET, text, ENCODER.encode(body));
      expect(`${text}: ${await reasonOf(verifyAt(body, nodeHeaders(signature, text)))}`).toBe(
        `${text}: bad_signature`,
      );
    }
  });

  it('T5e: trims only SP and HTAB around a signature entry, no other whitespace', async () => {
    const body = `{"event":"test","eventId":"${EVENT_ID}","store":"${STORE}"}`;
    const good = sign(body);
    expect(await reasonOf(verifyAt(body, nodeHeaders(` \t${good}\t `)))).toBe('ok');
    // Node decodes obs-text header bytes as latin1, so 0xA0 reaches us as U+00A0.
    for (const edge of ['\u00A0', '\n', '\r', '\v', '\f', '\uFEFF', '\u2028']) {
      const label = JSON.stringify(edge);
      for (const signature of [`${good}${edge}`, `${edge}${good}`]) {
        expect(`${label}: ${await reasonOf(verifyAt(body, nodeHeaders(signature)))}`).toBe(
          `${label}: bad_signature`,
        );
      }
    }
  });

  it('T5b: accepts any good v1 in a signature list', async () => {
    const good = sign(ORDER_PAID_BODY);
    const bad = `v1=${'0'.repeat(64)}`;
    const lists: WebhookHeaders[] = [
      nodeHeaders(`${bad},${good}`),
      nodeHeaders(`${good}, ${bad}`),
      nodeHeaders(`v2=abc, ${good}`),
      nodeHeaders(`v2=x ,\t ${good}`),
      nodeHeaders(`v2=x , ${good} ,v2=y`),
      { 'x-elisym-signature': [bad, good], 'x-elisym-timestamp': String(TS) },
      {
        'x-elisym-signature': bad,
        'X-Elisym-Signature': good,
        'x-elisym-timestamp': String(TS),
      },
      nodeHeaders([...Array.from({ length: 7 }, () => 'v2=x'), good].join(',')),
      // Empty entries are dropped before the cap: 1 entry, not 9.
      nodeHeaders(`${good}${','.repeat(8)}`),
    ];
    for (const headers of lists) {
      expect(await reasonOf(verifyAt(ORDER_PAID_BODY, headers))).toBe('ok');
    }
  });

  it('T5c: takes 0 and 12-digit timestamps', async () => {
    for (const timestamp of [0, 999_999_999_999]) {
      const headers = nodeHeaders(sign(ORDER_PAID_BODY, timestamp), timestamp);
      expect(
        `${timestamp}: ${await reasonOf(verifyAt(ORDER_PAID_BODY, headers, { now: timestamp }))}`,
      ).toBe(`${timestamp}: ok`);
    }
  });

  it('T5d: treats a header value that is not a string as absent', async () => {
    const signature = sign(ORDER_PAID_BODY);
    const shapes = [
      new Map<string, unknown>([
        ['x-elisym-signature', signature],
        ['x-elisym-timestamp', TS],
      ]),
      { 'x-elisym-signature': signature, 'x-elisym-timestamp': TS },
    ];
    for (const headers of shapes) {
      expect(await verifyAt(ORDER_PAID_BODY, headers as unknown as WebhookHeaders)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  it('T6: accepts an uppercase hex signature', async () => {
    expect(
      await reasonOf(verifyAt(ORDER_PAID_BODY, nodeHeaders(`v1=${goodHex().toUpperCase()}`))),
    ).toBe('ok');
  });

  it('T7: is fresh within the window, both ways, and stale past it', async () => {
    const atOffset = (offset: number, extra: Partial<VerifyWebhookInput> = {}) =>
      reasonOf(
        verifyAt(ORDER_PAID_BODY, nodeHeaders(sign(ORDER_PAID_BODY, TS + offset), TS + offset), {
          now: TS,
          ...extra,
        }),
      );
    expect(WEBHOOK_TOLERANCE_SECS).toBe(300);
    expect(await atOffset(-300)).toBe('ok');
    expect(await atOffset(300)).toBe('ok');
    expect(await atOffset(-301)).toBe('stale');
    expect(await atOffset(301)).toBe('stale');
    expect(await atOffset(0, { toleranceSecs: 0 })).toBe('ok');
    expect(await atOffset(1, { toleranceSecs: 0 })).toBe('stale');
    expect(await atOffset(-1, { toleranceSecs: 0 })).toBe('stale');
    // A fractional now is not floored: 300.5 seconds is past the window.
    expect(await atOffset(-300, { now: TS + 0.5 })).toBe('stale');
    const realNow = Math.floor(Date.now() / 1000);
    expect(
      await reasonOf(
        verifyWebhook({
          secret: SECRET,
          body: ORDER_PAID_BODY,
          headers: nodeHeaders(sign(ORDER_PAID_BODY, realNow), realNow),
        }),
      ),
    ).toBe('ok');
  });

  it('T7b: floors the default now, so a sub-second clock stays inside the window', async () => {
    const headers = nodeHeaders(sign(ORDER_PAID_BODY));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime((TS + 300) * 1000 + 900);
      expect(
        await reasonOf(verifyWebhook({ secret: SECRET, body: ORDER_PAID_BODY, headers })),
      ).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('T8: checks the signature before freshness and before parsing', async () => {
    const stale = TS - 10_000;
    const badStale = nodeHeaders(sign(ORDER_PAID_BODY, stale, OTHER_SECRET), stale);
    expect(await reasonOf(verifyAt(ORDER_PAID_BODY, badStale))).toBe('bad_signature');
    const notJson = 'not json';
    expect(await reasonOf(verifyAt(notJson, nodeHeaders(sign(notJson, TS, OTHER_SECRET))))).toBe(
      'bad_signature',
    );
  });

  it('T9: gives malformed only after a good signature', async () => {
    const bodies: [string, string][] = [
      ['not JSON', '{"event":'],
      ['null', 'null'],
      ['an array', '[]'],
      ['a string', '"order.paid"'],
      ['event missing', orderPaidWith(['event'], REMOVE)],
      ['event a number', orderPaidWith(['event'], 7)],
      ['amount a number', orderPaidWith(['payment', 'amount'], 1_500_000)],
      ['paidAt a string', orderPaidWith(['payment', 'paidAt'], String(TS))],
      ['paidAt negative', orderPaidWith(['payment', 'paidAt'], -1)],
      ['paidAt fractional', orderPaidWith(['payment', 'paidAt'], 1.5)],
      [
        'paidAt past the safe integers',
        orderPaidWith(['payment', 'paidAt'], 9_007_199_254_740_992),
      ],
      ['decimals 6.5', orderPaidWith(['payment', 'decimals'], 6.5)],
      ['decimals -1', orderPaidWith(['payment', 'decimals'], -1)],
      ['decimals 256', orderPaidWith(['payment', 'decimals'], 256)],
      ['decimals a string', orderPaidWith(['payment', 'decimals'], '6')],
      ['product a string', orderPaidWith(['product'], PRODUCT)],
      ['product null', orderPaidWith(['product'], null)],
      ['payment null', orderPaidWith(['payment'], null)],
      ['payment a string', orderPaidWith(['payment'], 'paid')],
      ['payment an array', orderPaidWith(['payment'], [])],
      ['empty orderId', orderPaidWith(['orderId'], '')],
      ['empty customerRef', orderPaidWith(['customerRef'], '')],
      ['customerRef null', orderPaidWith(['customerRef'], null)],
      ['empty email', orderPaidWith(['email'], '')],
      ['empty symbol', orderPaidWith(['payment', 'symbol'], '')],
      ['amountDisplay a number', orderPaidWith(['payment', 'amountDisplay'], 1.5)],
      ['amountDisplay null', orderPaidWith(['payment', 'amountDisplay'], null)],
      ['decimals null', orderPaidWith(['payment', 'decimals'], null)],
      ['email a number', orderPaidWith(['email'], 7)],
      ['email null', orderPaidWith(['email'], null)],
      ['symbol a number', orderPaidWith(['payment', 'symbol'], 7)],
      ['symbol null', orderPaidWith(['payment', 'symbol'], null)],
      ['empty asset', orderPaidWith(['payment', 'asset'], '')],
      ['empty tx', orderPaidWith(['payment', 'tx'], '')],
      ['empty medium', orderPaidWith(['payment', 'medium'], '')],
      ['empty address', orderPaidWith(['product', 'address'], '')],
      ['amount -1', orderPaidWith(['payment', 'amount'], '-1')],
      ['amount 01', orderPaidWith(['payment', 'amount'], '01')],
      ['amount 1.5', orderPaidWith(['payment', 'amount'], '1.5')],
      ['amount 40 digits', orderPaidWith(['payment', 'amount'], `1${'0'.repeat(39)}`)],
      ['amount with a trailing char', orderPaidWith(['payment', 'amount'], '15x')],
      ['eventId 63 hex', orderPaidWith(['eventId'], 'c'.repeat(63))],
      ['eventId uppercase', orderPaidWith(['eventId'], 'C'.repeat(64))],
      ['eventId trailing char', orderPaidWith(['eventId'], `${'c'.repeat(64)}x`)],
      ['store 63 hex', orderPaidWith(['store'], 'a'.repeat(63))],
      ['buyerPubkey not hex', orderPaidWith(['buyerPubkey'], 'z'.repeat(64))],
      ['test without store', '{"event":"test","eventId":"' + EVENT_ID + '"}'],
      ['test with a bad eventId', '{"event":"test","eventId":"x","store":"' + STORE + '"}'],
    ];
    for (const path of [
      ['eventId'],
      ['store'],
      ['orderId'],
      ['buyerPubkey'],
      ['product'],
      ['product', 'address'],
      ['payment'],
      ['payment', 'asset'],
      ['payment', 'amount'],
      ['payment', 'tx'],
      ['payment', 'medium'],
      ['payment', 'paidAt'],
    ]) {
      bodies.push([`${path.join('.')} missing`, orderPaidWith(path, REMOVE)]);
    }
    const caps: [string[], number][] = [
      [['orderId'], 256],
      [['customerRef'], 256],
      [['product', 'address'], 512],
      [['payment', 'asset'], 512],
      [['payment', 'amountDisplay'], 128],
      [['payment', 'symbol'], 64],
      [['payment', 'tx'], 512],
      [['payment', 'medium'], 64],
      [['email'], 512],
    ];
    for (const [path, cap] of caps) {
      bodies.push([`${path.join('.')} cap + 1`, orderPaidWith(path, 'q'.repeat(cap + 1))]);
    }
    for (const path of [
      ['orderId'],
      ['customerRef'],
      ['email'],
      ['product', 'address'],
      ['payment', 'asset'],
      ['payment', 'tx'],
      ['payment', 'medium'],
      ['payment', 'symbol'],
    ]) {
      bodies.push([`${path.join('.')} a one-string array`, orderPaidWith(path, ['x'])]);
    }
    for (const [name, body] of bodies) {
      expect(`${name}: ${await signedReason(body)}`).toBe(`${name}: malformed`);
    }

    // Invalid UTF-8 outside a string, and (the fatal decoder) inside the email value.
    const outside = Uint8Array.from([...ENCODER.encode('{"event":"test",'), 0xff, 0x7d]);
    const [beforeEmail, afterEmail] = ORDER_PAID_BODY.split('buyer@example.com');
    const inside = Uint8Array.from([
      ...ENCODER.encode(`${beforeEmail ?? ''}buyer`),
      0xff,
      ...ENCODER.encode(`@example.com${afterEmail ?? ''}`),
    ]);
    for (const bytes of [outside, inside]) {
      const headers = nodeHeaders(rawSign(SECRET, String(TS), bytes));
      expect(await reasonOf(verifyAt(bytes, headers))).toBe('malformed');
    }

    // A BOM is kept, so JSON.parse refuses it, as bytes and as the same text.
    const withBom = `\uFEFF${ORDER_PAID_BODY}`;
    const bomBytes = ENCODER.encode(withBom);
    expect(Array.from(bomBytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const bomHeaders = nodeHeaders(rawSign(SECRET, String(TS), bomBytes));
    expect(await reasonOf(verifyAt(bomBytes, bomHeaders))).toBe('malformed');
    expect(await reasonOf(verifyAt(withBom, bomHeaders))).toBe('malformed');
  });

  it('T9b: gives unknown_event for a signed, fresh event it does not know', async () => {
    const body = `{"event":"order.refunded","eventId":"${EVENT_ID}","store":"${STORE}"}`;
    expect(await signedReason(body)).toBe('unknown_event');
    const stale = TS - 1_000;
    expect(await reasonOf(verifyAt(body, nodeHeaders(sign(body, stale), stale)))).toBe('stale');
    expect(await reasonOf(verifyAt(body, nodeHeaders(sign(body, TS, OTHER_SECRET))))).toBe(
      'bad_signature',
    );
  });

  it('T9c: gives unknown_event for a signed, fresh empty-string event', async () => {
    const body = `{"event":"","eventId":"${EVENT_ID}","store":"${STORE}"}`;
    expect(await signedReason(body)).toBe('unknown_event');
  });

  it('T10: ignores unknown fields and accepts what the node may send', async () => {
    const extra = JSON.stringify({
      ...ORDER_PAID,
      future: { nested: true },
      ['__proto__']: { polluted: true },
      product: { ...ORDER_PAID.product, title: 'Course' },
      payment: { ...ORDER_PAID.payment, fee: '0' },
    });
    const result = await verifyAt(extra, nodeHeaders(sign(extra)));
    expect(result).toEqual({ ok: true, event: ORDER_PAID });
    if (!result.ok || result.event.event !== 'order.paid') {
      throw new Error('not order.paid');
    }
    expect(Object.keys(result.event)).not.toContain('future');
    expect(Object.keys(result.event.product)).toEqual(['address']);
    expect(Object.keys(result.event.payment)).not.toContain('fee');
    expect(Object.getPrototypeOf(result.event)).toBe(Object.prototype);

    const { customerRef: _ref, email: _email, ...required } = ORDER_PAID;
    const {
      amountDisplay: _display,
      decimals: _decimals,
      symbol: _symbol,
      ...payment
    } = ORDER_PAID.payment;
    const minimal = { ...required, payment };
    const minimalBody = JSON.stringify(minimal);
    const minimalResult = await verifyAt(minimalBody, nodeHeaders(sign(minimalBody)));
    expect(minimalResult).toEqual({ ok: true, event: minimal });
    if (!minimalResult.ok || minimalResult.event.event !== 'order.paid') {
      throw new Error('not order.paid');
    }
    for (const key of ['customerRef', 'email']) {
      expect(Object.keys(minimalResult.event)).not.toContain(key);
    }
    for (const key of ['amountDisplay', 'decimals', 'symbol']) {
      expect(Object.keys(minimalResult.event.payment)).not.toContain(key);
    }

    // Shapes intake would refuse today, within the caps (MED-1).
    for (const [path, value] of [
      [['orderId'], 'not a uuid / with spaces'],
      [['customerRef'], 'email@like.example with spaces'],
      [['payment', 'asset'], 'eip155:1/erc20:0xAbC'],
      [['payment', 'tx'], '0xdeadbeef'],
      [['payment', 'amountDisplay'], ''],
      [['payment', 'decimals'], 0],
      [['payment', 'decimals'], 255],
      [['payment', 'amount'], '0'],
      [['payment', 'amount'], `9${'9'.repeat(38)}`],
      [['payment', 'paidAt'], 0],
    ] as const) {
      expect(await signedReason(orderPaidWith(path, value))).toBe('ok');
    }
    for (const [path, cap] of [
      [['orderId'], 256],
      [['customerRef'], 256],
      [['product', 'address'], 512],
      [['payment', 'asset'], 512],
      [['payment', 'amountDisplay'], 128],
      [['payment', 'symbol'], 64],
      [['payment', 'tx'], 512],
      [['payment', 'medium'], 64],
      [['email'], 512],
    ] as const) {
      const body = orderPaidWith(path, 'q'.repeat(cap));
      expect(`${path.join('.')}: ${await signedReason(body)}`).toBe(`${path.join('.')}: ok`);
    }

    // String fields come back verbatim: no trimming of edge whitespace.
    const padded: OrderPaidWebhookEvent = {
      ...ORDER_PAID,
      orderId: ` ${ORDER_PAID.orderId} `,
      customerRef: ' user-123 ',
      product: { address: ` ${PRODUCT} ` },
      payment: { ...ORDER_PAID.payment, symbol: ' USDC ', tx: ` ${SIG} ` },
      email: ' buyer@example.com ',
    };
    const paddedBody = JSON.stringify(padded);
    expect(await verifyAt(paddedBody, nodeHeaders(sign(paddedBody)))).toEqual({
      ok: true,
      event: padded,
    });
  });

  it('T10b: reads only own fields, never a polluted prototype', async () => {
    const { email: _email, ...withoutEmail } = ORDER_PAID;
    const body = JSON.stringify(withoutEmail);
    Object.defineProperty(Object.prototype, 'email', {
      value: 'polluted@example.com',
      configurable: true,
      writable: true,
    });
    try {
      const result = await verifyAt(body, nodeHeaders(sign(body)));
      expect(result.ok).toBe(true);
      expect(result.ok && Object.hasOwn(result.event, 'email')).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'email');
    }
    expect(Object.hasOwn(Object.prototype, 'email')).toBe(false);

    const { decimals: _decimals, ...paymentWithoutDecimals } = ORDER_PAID.payment;
    const noDecimalsBody = JSON.stringify({ ...ORDER_PAID, payment: paymentWithoutDecimals });
    Object.defineProperty(Object.prototype, 'decimals', {
      value: 6,
      configurable: true,
      writable: true,
    });
    try {
      const result = await verifyAt(noDecimalsBody, nodeHeaders(sign(noDecimalsBody)));
      if (!result.ok || result.event.event !== 'order.paid') {
        throw new Error('not order.paid');
      }
      expect(Object.hasOwn(result.event.payment, 'decimals')).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'decimals');
    }
    expect(Object.hasOwn(Object.prototype, 'decimals')).toBe(false);

    const { event: _event, ...withoutEvent } = ORDER_PAID;
    const noEventBody = JSON.stringify(withoutEvent);
    const testWithoutStore = JSON.stringify({
      event: 'test',
      eventId: EVENT_ID,
    });
    const polluted: [string, unknown, string][] = [
      ['event', 'test', noEventBody],
      ['store', STORE, testWithoutStore],
      ['address', PRODUCT, orderPaidWith(['product', 'address'], REMOVE)],
      ['payment', ORDER_PAID.payment, orderPaidWith(['payment'], REMOVE)],
    ];
    for (const [key, value, pollutedBody] of polluted) {
      Object.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
        writable: true,
      });
      let reason: string;
      try {
        reason = await reasonOf(verifyAt(pollutedBody, nodeHeaders(sign(pollutedBody))));
      } finally {
        Reflect.deleteProperty(Object.prototype, key);
      }
      expect(`${key}: ${reason}`).toBe(`${key}: malformed`);
      expect(Object.hasOwn(Object.prototype, key)).toBe(false);
    }
  });

  it('T11: verifies a test event', async () => {
    const body = JSON.stringify({
      event: 'test',
      eventId: EVENT_ID,
      store: STORE,
    });
    expect(await verifyAt(body, nodeHeaders(sign(body)))).toEqual({
      ok: true,
      event: { event: 'test', eventId: EVENT_ID, store: STORE },
    });
  });

  it('T11b: a test event carries only event, eventId and store, whatever else the body holds', async () => {
    const body = JSON.stringify({
      event: 'test',
      eventId: EVENT_ID,
      store: STORE,
      amount: '1',
      future: { nested: true },
    });
    expect(await verifyAt(body, nodeHeaders(sign(body)))).toStrictEqual({
      ok: true,
      event: { event: 'test', eventId: EVENT_ID, store: STORE },
    });
  });

  it('T12: tries every secret given (rotation)', async () => {
    const headers = nodeHeaders(sign(ORDER_PAID_BODY));
    expect(
      await reasonOf(verifyAt(ORDER_PAID_BODY, headers, { secret: [OTHER_SECRET, SECRET] })),
    ).toBe('ok');
    expect(await reasonOf(verifyAt(ORDER_PAID_BODY, headers, { secret: [OTHER_SECRET] }))).toBe(
      'bad_signature',
    );
  });

  it('T13: throws on programmer errors', async () => {
    const headers = nodeHeaders(sign(ORDER_PAID_BODY));
    for (const secret of ['', [], 'x'.repeat(31), 'é'.repeat(15), [SECRET, 'short']]) {
      await expect(verifyAt(ORDER_PAID_BODY, headers, { secret })).rejects.toThrow(TypeError);
    }
    await expect(
      verifyAt(ORDER_PAID_BODY, headers, { secret: 7 as unknown as string }),
    ).rejects.toThrow(/secret must be a string or a non-empty array of strings/);
    await expect(verifyAt(ORDER_PAID_BODY, headers, { secret: [] })).rejects.toThrow(
      /secret must be a string or a non-empty array of strings/,
    );
    for (const body of [{}, null, new ArrayBuffer(4), new DataView(new ArrayBuffer(4))]) {
      await expect(verifyAt(body as unknown as string, headers)).rejects.toThrow(
        /body must be a string or a Uint8Array/,
      );
    }
    await expect(verifyAt(new Uint16Array(2) as unknown as string, headers)).rejects.toThrow(
      /body must be a string or a Uint8Array/,
    );
    const fakeTag = { [Symbol.toStringTag]: 'Uint8Array' };
    expect(Object.prototype.toString.call(fakeTag)).toBe('[object Uint8Array]');
    await expect(verifyAt(fakeTag as unknown as string, headers)).rejects.toThrow(
      /body must be a string or a Uint8Array/,
    );
    for (const toleranceSecs of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(verifyAt(ORDER_PAID_BODY, headers, { toleranceSecs })).rejects.toThrow(
        TypeError,
      );
    }
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(verifyAt(ORDER_PAID_BODY, headers, { now })).rejects.toThrow(TypeError);
    }
    for (const timestamp of [1.5, -1, Number.NaN]) {
      await expect(signWebhook({ secret: SECRET, timestamp, body: '{}' })).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      signWebhook({
        secret: SECRET,
        timestamp: Number.MAX_SAFE_INTEGER + 1,
        body: '{}',
      }),
    ).rejects.toThrow(/timestamp must be a non-negative safe integer/);
    await expect(
      signWebhook({
        secret: SECRET,
        timestamp: TS,
        body: ENCODER.encode('{}') as unknown as string,
      }),
    ).rejects.toThrow(/body must be a string/);
    await expect(
      signWebhook({ secret: 'x'.repeat(31), timestamp: TS, body: '{}' }),
    ).rejects.toThrow(TypeError);
    await expect(signWebhook({ secret: 'short', timestamp: TS, body: '{}' })).rejects.toThrow(
      /^signWebhook: /,
    );
    await expect(verifyAt(ORDER_PAID_BODY, headers, { secret: 'short' })).rejects.toThrow(
      /^verifyWebhook: /,
    );
    expect(WEBHOOK_MIN_SECRET_BYTES).toBe(32);
  });

  it('T13b: throws a clear Error without WebCrypto', async () => {
    const headers = nodeHeaders(sign(ORDER_PAID_BODY));
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(verifyAt(ORDER_PAID_BODY, headers)).rejects.toThrow(
        /needs globalThis\.crypto\.subtle/,
      );
      await expect(
        signWebhook({ secret: SECRET, timestamp: TS, body: ORDER_PAID_BODY }),
      ).rejects.toThrow(/needs globalThis\.crypto\.subtle/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalThis.crypto.subtle).toBeDefined();
  });

  it('T14: never puts the secret in a result or an error', async () => {
    const shortSecret = 'SENTINEL-short-secret';
    const longSecret = `SENTINEL-${'s'.repeat(32)}`;
    const messages: string[] = [];
    for (const attempt of [
      () =>
        verifyAt(ORDER_PAID_BODY, nodeHeaders(sign(ORDER_PAID_BODY)), {
          secret: shortSecret,
        }),
      () => signWebhook({ secret: shortSecret, timestamp: TS, body: '{}' }),
      () =>
        verifyAt(ORDER_PAID_BODY, nodeHeaders(sign(ORDER_PAID_BODY)), {
          secret: [longSecret, ''],
        }),
    ]) {
      await attempt().catch((error: unknown) => {
        messages.push(error instanceof Error ? error.message : String(error));
      });
    }
    expect(messages).toHaveLength(3);
    const results = [
      await verifyAt(ORDER_PAID_BODY, nodeHeaders(sign(ORDER_PAID_BODY, TS, longSecret)), {
        secret: longSecret,
      }),
      await verifyAt(ORDER_PAID_BODY, nodeHeaders(sign(ORDER_PAID_BODY)), {
        secret: longSecret,
      }),
    ];
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    for (const text of [...messages, JSON.stringify(results)]) {
      expect(text).not.toContain('SENTINEL');
    }
  });

  it('T15: names the headers exactly as the node sends them', () => {
    expect(WEBHOOK_EVENT_HEADER).toBe('X-Elisym-Event');
    expect(WEBHOOK_EVENT_ID_HEADER).toBe('X-Elisym-Event-Id');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('X-Elisym-Timestamp');
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Elisym-Signature');
  });
});
