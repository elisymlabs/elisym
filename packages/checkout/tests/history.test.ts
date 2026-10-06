import { type LoadedOffer, type OrderRecord, loadOffer } from '@elisym/commerce/buyer';
import { NATIVE_SOL } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import { MemoryRelays, NOW, inboxList, makeShop } from '../../commerce/tests/buyer/fixtures';
import { type Purchase, csvFileName, purchasesCsv, purchasesOf } from '../src/app/history';
import type { Receipt } from '../src/app/session';

type Ready = Extract<LoadedOffer, { ok: true }>;

const SECRET = '5'.repeat(64);
const WIRE = 'V0lSRS1UUkFOU0FDVElPTi1TRUNSRVQ=';
const WRAP_ID = '7'.repeat(64);
const EMAIL = 'buyer@example.com';

async function loaded(): Promise<Ready> {
  const shop = makeShop();
  const relays = new MemoryRelays([
    ...shop.events,
    inboxList(shop.store, ['wss://inbox.example.com']),
  ]);
  const offer = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: 'https://merchant.example',
    families: ['solana'],
    now: NOW,
  });
  if (!offer.ok) {
    throw new Error(offer.message);
  }
  return offer;
}

/** A record of `offer`, as the checkout stores one; `fields` set its state and the rest. */
function recordOf(offer: Ready, fields: Partial<OrderRecord>): OrderRecord {
  const payout = offer.payouts[0];
  if (payout === undefined) {
    throw new Error('no payout');
  }
  return {
    orderId: '1'.repeat(64),
    productAddress: offer.productAddress,
    storePubkey: offer.offer.storePubkey,
    buyerSecretKey: SECRET,
    buyerPubkey: '2'.repeat(64),
    createdAt: NOW,
    version: 3,
    state: 'completed',
    payout: { caip19: payout.target.caip19.id, address: payout.target.address },
    amount: '49000000',
    medium: 'solana-devnet',
    reference: '3'.repeat(44),
    offer: offer.offer,
    inboxRelays: ['wss://inbox.example.com'],
    acknowledgedRelays: ['wss://inbox.example.com'],
    orderWrap: {
      id: WRAP_ID,
      kind: 1059,
      content: '',
      tags: [],
      pubkey: '',
      sig: '',
      created_at: 0,
    },
    ...fields,
  };
}

function scope(offer: Ready, customerRef?: string) {
  return {
    storePubkey: offer.offer.storePubkey,
    customerRef,
    productAddress: offer.productAddress,
  };
}

describe('which records are purchases', () => {
  it('lists payments only: finished, found, in progress or blocked (H11)', async () => {
    const offer = await loaded();
    const records = [
      recordOf(offer, { orderId: 'a'.repeat(64), state: 'created' }),
      recordOf(offer, { orderId: 'b'.repeat(64), state: 'ordered' }),
      recordOf(offer, {
        orderId: 'c'.repeat(64),
        state: 'ordered',
        status: { status: 'cancelled', at: NOW },
      }),
      recordOf(offer, { orderId: 'd'.repeat(64), state: 'ended-unpaid' }),
      recordOf(offer, { orderId: 'e'.repeat(64), state: 'paid', paidTx: '9'.repeat(88) }),
      recordOf(offer, { orderId: 'f'.repeat(64), state: 'paying' }),
      recordOf(offer, { orderId: '0'.repeat(64), state: 'blocked' }),
      recordOf(offer, {
        orderId: '3'.repeat(64),
        state: 'completed',
        status: { status: 'completed', at: NOW, delivery: 'key' },
      }),
      recordOf(offer, {
        orderId: '4'.repeat(64),
        state: 'refunded',
        status: { status: 'cancelled', at: NOW, refunded: true },
      }),
    ];
    const listed = purchasesOf(records, scope(offer));
    expect(
      Object.fromEntries(listed.map((purchase) => [purchase.orderId[0], purchase.status])),
    ).toEqual({
      e: 'waiting_store',
      f: 'paying',
      '0': 'blocked',
      '3': 'delivered',
      '4': 'refunded',
    });
  });

  it('a paid order the store cancelled with no refund stated: its own status, never waiting (H11)', async () => {
    const offer = await loaded();
    const [purchase] = purchasesOf(
      [
        recordOf(offer, {
          state: 'paid',
          paidTx: '9'.repeat(88),
          status: { status: 'cancelled', at: NOW },
        }),
      ],
      scope(offer),
    );
    expect(purchase?.status).toBe('cancelled_paid');
    expect(purchase?.receipt.openStatus).toBe('cancelled_paid');
    expect(purchasesCsv(purchase === undefined ? [] : [purchase])).toContain(
      'Cancelled by the store (no refund stated)',
    );
  });

  it('newest first, ties by order id', async () => {
    const offer = await loaded();
    const listed = purchasesOf(
      [
        recordOf(offer, { orderId: 'b'.repeat(64), createdAt: NOW }),
        recordOf(offer, { orderId: 'c'.repeat(64), createdAt: NOW + 5 }),
        recordOf(offer, { orderId: 'a'.repeat(64), createdAt: NOW }),
      ],
      scope(offer),
    );
    expect(listed.map((purchase) => purchase.orderId[0])).toEqual(['c', 'a', 'b']);
  });

  it('only the page’s own account: a reference, another one, or none (H6)', async () => {
    const offer = await loaded();
    const records = [
      recordOf(offer, { orderId: 'a'.repeat(64), customerRef: 'user_a' }),
      recordOf(offer, { orderId: 'b'.repeat(64), customerRef: 'user_b' }),
      recordOf(offer, { orderId: 'c'.repeat(64) }),
    ];
    const ids = (ref?: string) =>
      purchasesOf(records, scope(offer, ref)).map((purchase) => purchase.orderId[0]);
    expect(ids('user_a')).toEqual(['a']);
    expect(ids('user_b')).toEqual(['b']);
    expect(ids(undefined)).toEqual(['c']);
  });

  it('only this store, and every product of it (H7)', async () => {
    const offer = await loaded();
    const records = [
      recordOf(offer, { orderId: 'a'.repeat(64) }),
      recordOf(offer, {
        orderId: 'b'.repeat(64),
        productAddress: `30402:${offer.offer.storePubkey}:other-product`,
      }),
      recordOf(offer, { orderId: 'c'.repeat(64), storePubkey: '8'.repeat(64) }),
    ];
    const listed = purchasesOf(records, scope(offer));
    expect(listed.map((purchase) => [purchase.orderId[0], purchase.thisProduct])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});

describe('what a purchase carries', () => {
  it('no secret of the record, in the purchases or the export (H8)', async () => {
    const offer = await loaded();
    const payout = offer.payouts[0];
    const records = [
      recordOf(offer, {
        orderId: 'a'.repeat(64),
        state: 'paying',
        marker: {
          rail: 'solana',
          attemptId: 'attempt',
          setAt: NOW,
          blockhash: 'hash',
          lastValidBlockHeight: '10',
          signature: '6'.repeat(88),
          signedTransaction: WIRE,
        },
        paymentRequest: 'REQUEST-SECRET',
      }),
      recordOf(offer, {
        orderId: 'b'.repeat(64),
        status: { status: 'completed', at: NOW, delivery: 'https://shop.example/d' },
      }),
    ];
    const listed = purchasesOf(records, scope(offer));
    const everything = `${JSON.stringify(listed)}\n${purchasesCsv(listed)}`;
    for (const secret of [
      SECRET,
      WIRE,
      WRAP_ID,
      'REQUEST-SECRET',
      '3'.repeat(44),
      payout?.target.address ?? 'no payout',
      '6'.repeat(88),
      EMAIL,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a delivery an older node sent is never carried into the list or the export (M9)', async () => {
    const offer = await loaded();
    const listed = purchasesOf(
      [
        recordOf(offer, {
          orderId: 'b'.repeat(64),
          createdAt: NOW + 1,
          status: { status: 'completed', at: NOW, delivery: 'https://shop.example/d' },
        }),
        recordOf(offer, {
          orderId: 'a'.repeat(64),
          status: { status: 'completed', at: NOW, delivery: 'LICENSE-KEY' },
        }),
      ],
      scope(offer),
    );
    expect(listed.map((each) => each.status)).toEqual(['delivered', 'delivered']);
    expect(listed.every((each) => !('delivery' in each))).toBe(true);
    const everything = `${JSON.stringify(listed)}\n${purchasesCsv(listed)}`;
    expect(everything).not.toContain('shop.example/d');
    expect(everything).not.toContain('LICENSE-KEY');
  });
});

/** A purchase for the export, from its receipt only. */
function purchase(receipt: Partial<Receipt>, extra: Partial<Purchase> = {}): Purchase {
  return {
    orderId: 'a'.repeat(64),
    createdAt: NOW,
    status: 'delivered',
    receipt: { store: 'Shop', product: 'Course', orderId: 'a'.repeat(64), ...receipt },
    assetId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:x',
    thisProduct: true,
    ...extra,
  };
}

function cells(csv: string): string[][] {
  // The test inputs hold no comma inside a quoted cell unless a test says so.
  return csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((row) => row.split('","').map((part) => part.replace(/^"|"$/g, '')));
}

describe('the export (D3)', () => {
  it('a header, then one quoted row per purchase', () => {
    const csv = purchasesCsv([purchase({})]);
    // A byte order mark first, so a spreadsheet reads the file as UTF-8.
    expect(csv.startsWith('\uFEFFdate,')).toBe(true);
    const [header, row] = csv.slice(1).trimEnd().split('\r\n');
    expect(header).toBe(
      'date,store,product,status,amount,asset,network,asset_id,order_id,transaction,explorer',
    );
    expect(
      row?.startsWith(`"${new Date(NOW * 1000).toISOString()}","Shop","Course","Completed"`),
    ).toBe(true);
    expect(purchasesCsv([])).toBe(`\uFEFF${header}\r\n`);
  });

  it('amounts through Decimal, never Number (H9)', () => {
    const usdc = { ...NATIVE_SOL, token: 'usdc', symbol: 'USDC', decimals: 6 };
    const eth = { ...NATIVE_SOL, token: 'eth', symbol: 'ETH', decimals: 18 };
    const amounts = [
      { amount: '1', asset: NATIVE_SOL },
      { amount: '10000', asset: usdc },
      { amount: '123456789012345678901', asset: eth },
    ].map(
      ({ amount, asset }) =>
        cells(
          purchasesCsv([
            purchase({ paying: { amount, asset, network: 'mainnet', chain: 'solana' } }),
          ]),
        )[1]?.[4],
    );
    expect(amounts).toEqual(['0.000000001', '0.01', '123.456789012345678901']);
  });

  it('a store’s formula is never run: sanitised, then prefixed, then quoted (H9, H16)', () => {
    const csv = purchasesCsv([
      purchase({ store: ' =cmd', product: '+cmd' }),
      purchase({ store: '@x', product: '-1' }),
      purchase({ store: '\t=cmd', product: 'say "hi"' }),
    ]);
    expect(csv).toContain(`"'=cmd"`);
    expect(csv).toContain(`"'+cmd"`);
    expect(csv).toContain(`"'@x"`);
    expect(csv).toContain(`"'-1"`);
    expect(csv).toContain(`"say ""hi"""`);
  });

  it('names a transaction only when this checkout confirmed the payment', () => {
    const tx = '8'.repeat(88);
    const paid = cells(
      purchasesCsv([purchase({ paid: { tx, explorer: `https://explorer.example/${tx}` } })]),
    )[1];
    expect(paid?.[9]).toBe(tx);
    expect(paid?.[10]).toBe(`https://explorer.example/${tx}`);
    const sent = cells(purchasesCsv([purchase({ sent: { tx } })]))[1];
    expect(sent?.[9]).toBe('');
  });

  it('names a real-money network by its chain alone, a test one with its network', () => {
    const network = (chain: 'solana' | 'tempo', on: 'mainnet' | 'devnet') =>
      cells(
        purchasesCsv([
          purchase({ paying: { amount: '1', asset: NATIVE_SOL, network: on, chain } }),
        ]),
      )[1]?.[6];
    expect(network('solana', 'mainnet')).toBe('Solana');
    expect(network('tempo', 'mainnet')).toBe('Tempo');
    expect(network('solana', 'devnet')).toBe('Solana devnet');
    expect(network('tempo', 'devnet')).toBe('Tempo devnet');
  });

  it('keeps the full status label, never the short badge (P14)', () => {
    const statuses = cells(
      purchasesCsv([
        purchase({}, { status: 'blocked' }),
        purchase({}, { status: 'cancelled_paid' }),
        purchase({}, { status: 'waiting_store' }),
      ]),
    )
      .slice(1)
      .map((row) => row[3]);
    expect(statuses).toEqual([
      'Payment blocked by the recipient',
      'Cancelled by the store (no refund stated)',
      'Waiting for the store',
    ]);
  });

  it('a file name from the store and the day', () => {
    expect(csvFileName('My Shop!', new Date('2026-10-05T12:00:00Z'))).toBe(
      'elisym-purchases-my-shop-2026-10-05.csv',
    );
    expect(csvFileName(undefined, new Date('2026-10-05T12:00:00Z'))).toBe(
      'elisym-purchases-store-2026-10-05.csv',
    );
  });
});
