import { buildPaytoEvent, buildProductEvent, unwrapOrderMessage } from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import { type EventTemplate, type VerifiedEvent, finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  checkDomain,
  checkInboxRelays,
  inboxRelaysNotRead,
  newest,
  newestListings,
  offerProblems,
  offersNotHonoured,
  readBeforeSetup,
  readRelayViews,
} from '../src/checks';
import type { PublishRelay } from '../src/publish';
import { deliveryDone } from '../src/reply';
import { PAYOUT, T0, USDC_DEVNET_CAIP19, key } from './fixtures';

const MAINNET_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEMPO_USDC = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_PAYOUT = '0x1111111111111111111111111111111111111111';
const STANDING = [
  { d: 'course', caip19: USDC_DEVNET_CAIP19, payout: PAYOUT as string, amount: '1000000' },
];

type Behaviour = 'serves' | 'takes' | 'refuses' | 'auth-then-recipient-only';

/**
 * Relays that each take, keep and serve gift wraps as told. Like nostr-tools, a
 * connection authenticates once: `connect()` gives a pool with its own connections.
 */
function relays(behaviours: Record<string, Behaviour>) {
  const stored = new Map<string, NostrEvent[]>();
  const connect = () => {
    const authedAs = new Map<string, string>();
    const signIn = async (
      url: string,
      signer: (template: EventTemplate) => Promise<VerifiedEvent>,
    ) => {
      if (!authedAs.has(url)) {
        const proof = await signer({ kind: 22242, created_at: T0, tags: [], content: '' });
        authedAs.set(url, proof.pubkey);
      }
    };
    return {
      ensureRelay: async (url: string): Promise<PublishRelay> => ({
        publish: async (event: NostrEvent) => {
          if (behaviours[url] === 'refuses') {
            throw new Error('blocked: not allowed');
          }
          if (behaviours[url] === 'auth-then-recipient-only' && !authedAs.has(url)) {
            throw new Error('auth-required: sign in');
          }
          if (behaviours[url] !== 'takes') {
            stored.set(url, [...(stored.get(url) ?? []), event]);
          }
          return '';
        },
        auth: async (signer) => {
          await signIn(url, signer);
          return '';
        },
      }),
      querySync: async (
        urls: string[],
        filter: Filter,
        params: { onauth?: (template: EventTemplate) => Promise<VerifiedEvent> },
      ): Promise<NostrEvent[]> => {
        const url = urls[0] ?? '';
        let events = stored.get(url) ?? [];
        if (behaviours[url] === 'auth-then-recipient-only') {
          if (params.onauth !== undefined) {
            await signIn(url, params.onauth);
          }
          const reader = authedAs.get(url);
          events = events.filter((event) =>
            event.tags.some((tag) => tag[0] === 'p' && tag[1] === reader),
          );
        }
        return events.filter((event) => filter.ids?.includes(event.id) ?? true);
      },
    };
  };
  return connect;
}

describe('checking the inbox relays', () => {
  const behaviours: Record<string, Behaviour> = {
    'wss://a': 'serves',
    'wss://b': 'takes',
    'wss://c': 'refuses',
    'wss://d': 'auth-then-recipient-only',
  };

  it('publishes the probe alone: no copy wrapped to the store key', async () => {
    const store = key();
    const connect = relays({ 'wss://a': 'serves' });
    const base = connect();
    const published: NostrEvent[] = [];
    const writer = {
      ensureRelay: async (url: string): Promise<PublishRelay> => {
        const relay = await base.ensureRelay(url);
        return {
          ...relay,
          publish: async (event: NostrEvent) => {
            published.push(event);
            return relay.publish(event);
          },
        };
      },
    };
    await checkInboxRelays(
      writer,
      connect(),
      ['wss://a'],
      store.secretKey,
      async (template) => finalizeEvent(template, store.secretKey),
      () => undefined,
      T0,
    );
    expect(published).toHaveLength(1);
    const [probe] = published;
    expect(probe?.tags.some((tag) => tag[0] === 'p' && tag[1] === store.pubkey)).toBe(false);
    if (probe === undefined) {
      throw new Error('no probe published');
    }
    expect(unwrapOrderMessage(probe, store.secretKey)).toBeUndefined();
  });

  it('says which relays take and serve a gift wrap for any key', async () => {
    const store = key();
    const connect = relays(behaviours);
    const verdicts = await checkInboxRelays(
      connect(),
      connect(),
      Object.keys(behaviours),
      store.secretKey,
      async (template) => finalizeEvent(template, store.secretKey),
      () => undefined,
      T0,
    );
    expect(verdicts).toEqual([
      { relay: 'wss://a', accepts: true, serves: true },
      { relay: 'wss://b', accepts: true, serves: false },
      { relay: 'wss://c', accepts: false, serves: false },
      { relay: 'wss://d', accepts: true, serves: true },
    ]);
  });

  it('would misjudge a relay read back on the connection the store signed in on', async () => {
    const store = key();
    const shared = relays(behaviours)();
    const verdicts = await checkInboxRelays(
      shared,
      shared,
      ['wss://d'],
      store.secretKey,
      async (template) => finalizeEvent(template, store.secretKey),
      () => undefined,
      T0,
    );
    expect(verdicts).toEqual([{ relay: 'wss://d', accepts: true, serves: false }]);
  });
});

function response(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers });
}

describe('checking the domain', () => {
  const expected = { names: { _: 'a'.repeat(64), owner: 'b'.repeat(64) } };
  const served = JSON.stringify(expected);
  const cors = { 'access-control-allow-origin': '*' };

  it('passes when the domain serves the names with CORS', async () => {
    const urls: string[] = [];
    const verdict = await checkDomain('shop.example', expected, async (url) => {
      urls.push(String(url));
      return response(served, cors);
    });
    expect(verdict.ok).toBe(true);
    expect(urls).toEqual(['https://shop.example/.well-known/nostr.json?name=_']);
  });

  it('fails without CORS, on another answer, other names, or a broken document', async () => {
    const cases: [Response | Error, string][] = [
      [response(served), 'Access-Control-Allow-Origin'],
      [response(served, cors, 404), '404'],
      [response(JSON.stringify({ names: { _: 'c'.repeat(64) } }), cors), '"_"'],
      [response(JSON.stringify({ names: { _: 'a'.repeat(64) } }), cors), '"owner"'],
      [response('not json', cors), 'JSON'],
      [response(' '.repeat(64 * 1024 + 1), cors), 'too large'],
      [new Error('ENOTFOUND'), 'not reachable'],
    ];
    for (const [answer, problem] of cases) {
      const verdict = await checkDomain('shop.example', expected, async () => {
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.problem).toContain(problem);
    }
  });
});

describe('what the relays offer that the node does not honour', () => {
  const owner = key();
  const store = key();
  const list = (accept: { caip19: string; address: string }[]) =>
    finalizeEvent(
      buildPaytoEvent({ ownerPubkey: owner.pubkey, accept, createdAt: T0 }),
      owner.secretKey,
    );
  const listing = (amount: string, accept: string[]) =>
    finalizeEvent(
      buildProductEvent({
        d: 'course',
        title: 'Course',
        description: '',
        price: { amount, currency: 'USD' },
        accept,
        createdAt: T0,
      }),
      store.secretKey,
    );
  const usdc = list([{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }]);
  const oneUsd = listing('1', [USDC_DEVNET_CAIP19]);

  it('is nothing when the ledger stands behind every payable offer', () => {
    expect(offersNotHonoured([oneUsd], usdc, 'devnet', STANDING)).toEqual([]);
  });

  it('is a price the listing asks that the ledger does not record', () => {
    // A setup stopped after publishing the new listing, before writing the ledger.
    expect(
      offersNotHonoured([listing('0.80', [USDC_DEVNET_CAIP19])], usdc, 'devnet', STANDING),
    ).toEqual([`course: ${USDC_DEVNET_CAIP19} at 800000`]);
  });

  it('is a payout on another rail or network, or at an address the ledger does not know', () => {
    const tempo = list([
      { caip19: USDC_DEVNET_CAIP19, address: PAYOUT },
      { caip19: TEMPO_USDC, address: TEMPO_PAYOUT },
    ]);
    expect(offersNotHonoured([oneUsd], tempo, 'devnet', STANDING)).toEqual([
      `${TEMPO_USDC} ${TEMPO_PAYOUT}`,
    ]);
    const mainnet = list([{ caip19: MAINNET_USDC, address: PAYOUT }]);
    expect(offersNotHonoured([oneUsd], mainnet, 'devnet', STANDING)).toEqual([
      `${MAINNET_USDC} ${PAYOUT}`,
    ]);
    const other = '9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz';
    const moved = list([{ caip19: USDC_DEVNET_CAIP19, address: other }]);
    expect(offersNotHonoured([oneUsd], moved, 'devnet', STANDING)).toEqual([
      `${USDC_DEVNET_CAIP19} ${other}`,
      `course: ${USDC_DEVNET_CAIP19} at 1000000`,
    ]);
  });

  it('compares the coin too, not only the address', () => {
    const lsm =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
    const standing = [
      { d: 'course', caip19: MAINNET_USDC, payout: PAYOUT as string, amount: '1000000' },
    ];
    const mainnetListing = finalizeEvent(
      buildProductEvent({
        d: 'course',
        title: 'Course',
        description: '',
        price: { amount: '1', currency: 'USD' },
        accept: [MAINNET_USDC],
        createdAt: T0,
      }),
      store.secretKey,
    );
    expect(
      offersNotHonoured(
        [mainnetListing],
        list([{ caip19: lsm, address: PAYOUT }]),
        'mainnet',
        standing,
      ),
    ).toEqual([`${lsm} ${PAYOUT}`]);
  });

  it('skips a listed coin no payout list pays, and says when nothing was served', () => {
    expect(
      offersNotHonoured([listing('5', [USDC_DEVNET_CAIP19])], undefined, 'devnet', STANDING),
    ).toEqual([]);
    expect(offersNotHonoured([], undefined, 'devnet', STANDING)).toBeUndefined();
  });
});

describe('what the relays offer, product by product', () => {
  const owner = key();
  const store = key();
  const usdc = finalizeEvent(
    buildPaytoEvent({
      ownerPubkey: owner.pubkey,
      accept: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      createdAt: T0,
    }),
    owner.secretKey,
  );
  const listingOf = (d: string, amount: string, visibility = 'on-sale') =>
    finalizeEvent(
      buildProductEvent({
        d,
        title: d,
        description: '',
        price: { amount, currency: 'USD' },
        visibility,
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0,
      }),
      store.secretKey,
    );
  const course = { d: 'course', caip19: USDC_DEVNET_CAIP19, payout: PAYOUT as string };

  it("checks each listing against its own product's terms only", () => {
    const standing = [
      { ...course, amount: '1000000' },
      { ...course, d: 'deposit', amount: '10000000' },
    ];
    expect(
      offersNotHonoured(
        [listingOf('course', '1'), listingOf('deposit', '10')],
        usdc,
        'devnet',
        standing,
      ),
    ).toEqual([]);
    // The cheap product's terms never stand behind the dear one's listing.
    expect(
      offersNotHonoured([listingOf('deposit', '1')], usdc, 'devnet', [
        { ...course, amount: '1000000' },
      ]),
    ).toEqual([`deposit: ${USDC_DEVNET_CAIP19} at 1000000`]);
  });

  it('M16 S1: does not price a sold-out listing: a stopped product offers nothing', () => {
    expect(
      offersNotHonoured(
        [listingOf('course', '1'), listingOf('stopped', '5', 'sold-out')],
        usdc,
        'devnet',
        [{ ...course, amount: '1000000' }],
      ),
    ).toEqual([]);
  });

  it('M17 S2: judges the payout list only where something is on sale', () => {
    // Every product stopped and its terms retired: nothing stands, and the node still starts.
    expect(offersNotHonoured([listingOf('course', '1', 'sold-out')], usdc, 'devnet', [])).toEqual(
      [],
    );
    expect(offersNotHonoured([listingOf('course', '1')], usdc, 'devnet', [])).toEqual([
      `${USDC_DEVNET_CAIP19} ${PAYOUT}`,
      `course: ${USDC_DEVNET_CAIP19} at 1000000`,
    ]);
  });

  it('flags a listing still on sale for a stopped product once its terms are retired', () => {
    const standing = [{ ...course, d: 'other', amount: '1000000' }];
    expect(offersNotHonoured([listingOf('course', '1')], usdc, 'devnet', standing)).toEqual([
      `course: ${USDC_DEVNET_CAIP19} at 1000000`,
    ]);
  });
});

/**
 * A relay pool that serves `listings` by `#d`, and refuses (answers nothing
 * for) any subscription past `cap` open at once on one relay, counting every
 * read, as a relay capping subscriptions per connection does.
 */
function cappedPool(events: NostrEvent[], cap: number) {
  const open = new Map<string, number>();
  let refused = 0;
  let mostOpen = 0;
  const pool = {
    querySync: async (urls: string[], filter: Filter) => {
      const taken = urls.filter((url) => (open.get(url) ?? 0) < cap);
      refused += urls.length - taken.length;
      for (const url of taken) {
        open.set(url, (open.get(url) ?? 0) + 1);
        mostOpen = Math.max(mostOpen, open.get(url) ?? 0);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      for (const url of taken) {
        open.set(url, (open.get(url) ?? 1) - 1);
      }
      if (taken.length === 0) {
        return [];
      }
      return events.filter(
        (event) =>
          filter.kinds?.includes(event.kind) === true &&
          (filter['#d'] === undefined ||
            event.tags.some(
              (tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] ?? '') === true,
            )),
      );
    },
  };
  return { pool, stats: () => ({ refused, mostOpen }) };
}

describe('reading many products', () => {
  const owner = key();
  const store = key();
  const listingOf = (d: string, createdAt = T0) =>
    finalizeEvent(
      buildProductEvent({
        d,
        title: d,
        description: '',
        price: { amount: '1', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        createdAt,
      }),
      store.secretKey,
    );
  const payoutList = finalizeEvent(
    buildPaytoEvent({
      ownerPubkey: owner.pubkey,
      accept: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      createdAt: T0,
    }),
    owner.secretKey,
  );
  const inboxList = finalizeEvent(
    { kind: 10050, created_at: T0, tags: [['relay', 'wss://a.example']], content: '' },
    store.secretKey,
  );

  it('reads 120 products in chunks, the newest listing of each', async () => {
    const ds = Array.from({ length: 120 }, (_, index) => `p${index}`);
    const events = [...ds.map((d) => listingOf(d)), listingOf('p7', T0 + 5)];
    const { pool } = cappedPool(events, 4);
    const found = await newestListings(pool, ['wss://a.example'], store.pubkey, ds);
    expect(found.size).toBe(120);
    expect(found.get('p7')?.created_at).toBe(T0 + 5);
  });

  it('M43 M45: never holds more than 4 subscriptions on a relay, so 1500 products are all read', async () => {
    const ds = Array.from({ length: 1500 }, (_, index) => `p${index}`);
    const events = [...ds.map((d) => listingOf(d)), payoutList, inboxList];
    const pubkeys = { storePubkey: store.pubkey, ownerPubkey: owner.pubkey };
    const relaysOf = ['wss://a.example', 'wss://b.example'];
    const viewed = cappedPool(events, 4);
    const views = await readRelayViews(viewed.pool, [relaysOf, relaysOf], pubkeys, ds);
    expect(viewed.stats().refused).toBe(0);
    expect(viewed.stats().mostOpen).toBeLessThanOrEqual(4);
    for (const view of views) {
      expect(view.listings).toHaveLength(1500);
      expect(view.payoutList?.id).toBe(payoutList.id);
      expect(view.inboxList?.id).toBe(inboxList.id);
    }
    const { pool, stats } = cappedPool(events, 4);
    const setup = await readBeforeSetup(pool, relaysOf, relaysOf, pubkeys, ds);
    expect(stats().refused).toBe(0);
    expect(setup.listings.size).toBe(1500);
    expect(setup.payoutList?.id).toBe(payoutList.id);
  });
});

describe("the store's published inbox list", () => {
  const store = key();
  const inboxList = (relays: string[]) =>
    finalizeEvent(
      { kind: 10050, created_at: T0, tags: relays.map((relay) => ['relay', relay]), content: '' },
      store.secretKey,
    );

  it('is fine when the node reads every relay it names, however spelled', () => {
    expect(
      inboxRelaysNotRead(inboxList(['wss://a.example/', 'wss://b.example//inbox']), [
        'wss://a.example',
        'wss://b.example/inbox',
      ]),
    ).toEqual([]);
  });

  it('names a relay buyers send orders to that the node does not read', () => {
    expect(
      inboxRelaysNotRead(inboxList(['wss://old.example', 'wss://a.example']), ['wss://a.example']),
    ).toEqual(['wss://old.example']);
  });

  it('ignores what the checkout never uses, and says when no list was served', () => {
    const many = Array.from({ length: 10 }, (_, index) => `wss://r${index}.example`);
    expect(
      inboxRelaysNotRead(inboxList(['ws://plain.example', ...many]), many.slice(0, 8)),
    ).toEqual([]);
    expect(inboxRelaysNotRead(undefined, ['wss://a.example'])).toBeUndefined();
    // Hosts the checkout never contacts, however listed.
    expect(
      inboxRelaysNotRead(
        inboxList([
          'wss://10.0.0.5',
          'wss://localhost',
          'wss://u:p@r.example',
          'wss://r.example:443/',
        ]),
        ['wss://r.example'],
      ),
    ).toEqual([]);
  });
});

describe('judging every set of relays a page may read', () => {
  const owner = key();
  const store = key();
  const payoutList = finalizeEvent(
    buildPaytoEvent({
      ownerPubkey: owner.pubkey,
      accept: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      createdAt: T0,
    }),
    owner.secretKey,
  );
  const listing = (amount: string) =>
    finalizeEvent(
      buildProductEvent({
        d: 'course',
        title: 'Course',
        description: '',
        price: { amount, currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0,
      }),
      store.secretKey,
    );
  const inbox = finalizeEvent(
    { kind: 10050, created_at: T0, tags: [['relay', 'wss://a.example']], content: '' },
    store.secretKey,
  );

  it('passes a store whose every view the node honours', () => {
    const view = { listings: [listing('1')], payoutList, inboxList: inbox };
    expect(offerProblems([view, view], ['wss://a.example'], 'devnet', STANDING)).toEqual({
      problems: [],
      served: true,
    });
  });

  it('refuses when the default relays still serve an older price than the ledger records', () => {
    // The new listing reached only the store's own relay; pages hinting the old relays read the old one.
    const defaults = { listings: [listing('0.80')], payoutList, inboxList: inbox };
    const all = { listings: [listing('1')], payoutList, inboxList: inbox };
    expect(
      offerProblems([defaults, all], ['wss://a.example'], 'devnet', STANDING).problems,
    ).toEqual([`course: ${USDC_DEVNET_CAIP19} at 800000`]);
  });

  it('refuses an inbox relay the node does not read, in any view', () => {
    const moved = finalizeEvent(
      { kind: 10050, created_at: T0 + 1, tags: [['relay', 'wss://old.example']], content: '' },
      store.secretKey,
    );
    const view = { listings: [listing('1')], payoutList, inboxList: moved };
    expect(
      offerProblems([view, { ...view, inboxList: inbox }], ['wss://a.example'], 'devnet', STANDING)
        .problems,
    ).toEqual(['orders sent to wss://old.example, which this node does not read']);
  });

  it('says when nothing was served', () => {
    const empty = { listings: [], payoutList: undefined, inboxList: undefined };
    expect(offerProblems([empty, empty], ['wss://a.example'], 'devnet', STANDING)).toEqual({
      problems: [],
      served: false,
    });
  });
});

describe('choosing the event the checkout reads', () => {
  it('is the newest, and of two in one second the lowest id', () => {
    const author = key();
    const at = (createdAt: number, content: string) =>
      finalizeEvent({ kind: 10050, created_at: createdAt, tags: [], content }, author.secretKey);
    const older = at(T0, 'a');
    const newer = at(T0 + 1, 'b');
    expect(newest([newer, older])).toBe(newer);
    expect(newest([older, newer])).toBe(newer);
    const twin = at(T0 + 1, 'c');
    const lowest = twin.id < newer.id ? twin : newer;
    expect(newest([newer, twin])).toBe(lowest);
    expect(newest([twin, newer])).toBe(lowest);
    expect(newest([])).toBeUndefined();
  });
});

describe('when a delivery counts as done', () => {
  it('wants two relays (or all, when fewer), then any one once the payment settled', () => {
    expect(deliveryDone(0, 2, 0)).toBe(false);
    expect(deliveryDone(1, 2, 0)).toBe(false);
    expect(deliveryDone(2, 3, 0)).toBe(true);
    expect(deliveryDone(1, 1, 0)).toBe(true);
    expect(deliveryDone(1, 2, 60 * 60)).toBe(true);
    expect(deliveryDone(0, 2, 60 * 60)).toBe(false);
  });
});
