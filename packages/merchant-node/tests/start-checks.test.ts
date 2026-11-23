import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { offerProblems, readRelayViews } from '../src/checks';
import type { MerchantConfig } from '../src/config';
import { OFFER_RELAYS } from '../src/constants';
import { emptyLedger } from '../src/ledger';
import { runSetupPass, signedPayoutListProblem } from '../src/setup-ledger';
import {
  lostHistoryProblem,
  productPriceProblems,
  profileWarnings,
  readOfferProblems,
} from '../src/start-checks';
import {
  buildListingEvent,
  buildStoreSignedEvents,
  buildStoreWideEvents,
  ownerEventTemplates,
} from '../src/store-events';
import { publishTerms } from '../src/terms';
import { EIP3009_USDC, PAYER, PAYOUT, T0, USDC_DEVNET_CAIP19, key } from './fixtures';

const INBOX = 'wss://inbox.example.com';
const PAYOUTS = [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT as string }];
const CONFIG: MerchantConfig = {
  name: 'Shop',
  nip05: '_@shop.example',
  network: 'devnet',
  payouts: PAYOUTS,
  inboxRelays: [INBOX],
};
const PRODUCT = {
  d: 'course',
  title: 'Course',
  description: 'Lessons.',
  priceUsd: '1',
  onSale: true,
};

/** Relays that keep every event published to them and answer reads by filter. */
function relayPool() {
  const stored = new Map<string, NostrEvent[]>();
  return {
    add(relays: readonly string[], event: NostrEvent): void {
      for (const relay of relays) {
        stored.set(relay, [...(stored.get(relay) ?? []), event]);
      }
    },
    querySync: async (relays: string[], filter: Filter): Promise<NostrEvent[]> => {
      const found = new Map<string, NostrEvent>();
      for (const relay of relays) {
        for (const event of stored.get(relay) ?? []) {
          if (matchFilter(filter, event)) {
            found.set(event.id, event);
          }
        }
      }
      return [...found.values()];
    },
  };
}

describe('the split store-wide builders', () => {
  it('give the very events buildStoreWideEvents signs (same ids), in the same order', () => {
    const store = key();
    const owner = key();
    const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };
    for (const feeSupport of [false, true]) {
      const wide = buildStoreWideEvents(CONFIG, keys, T0 + 60, T0, feeSupport);
      const owned = ownerEventTemplates(CONFIG, owner.pubkey, store.pubkey, T0, T0 + 60, {
        mode: 'self-host',
      });
      const split = {
        payoutList: finalizeEvent(owned.payoutList, owner.secretKey),
        others: [
          ...buildStoreSignedEvents(CONFIG, store.secretKey, owner.pubkey, T0 + 60, feeSupport),
          finalizeEvent(owned.authorization, owner.secretKey),
        ],
      };
      expect(split.payoutList.id).toBe(wide.payoutList.id);
      expect(split.others.map((event) => event.id)).toEqual(wide.others.map((event) => event.id));
      expect(split.others.map((event) => event.kind)).toEqual([0, 10050, 30490]);
    }
  });

  it('name the operator of a hosted store, and leave the templates unsigned', () => {
    const owner = key();
    const store = key();
    const owned = ownerEventTemplates(CONFIG, owner.pubkey, store.pubkey, T0, T0 + 1, {
      mode: 'hosted',
      operator: 'elisym.network',
    });
    expect(owned.authorization.tags).toContainEqual(['mode', 'hosted', 'elisym.network']);
    expect(owned.authorization.created_at).toBe(T0 + 1);
    expect(owned.payoutList.created_at).toBe(T0);
    expect('sig' in owned.payoutList).toBe(false);
  });
});

describe('the start checks a host runs', () => {
  const store = key();
  const owner = key();
  const pubkeys = { storePubkey: store.pubkey, ownerPubkey: owner.pubkey };
  const products = new Map([[PRODUCT.d, PRODUCT]]);
  const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };

  /** A store published at 1 USD whose ledger now records `amount` for `course`. */
  function published(amount: string) {
    const pool = relayPool();
    const wide = buildStoreWideEvents(CONFIG, keys, T0, T0);
    for (const event of [wide.payoutList, ...wide.others]) {
      pool.add([...OFFER_RELAYS, INBOX], event);
    }
    pool.add(OFFER_RELAYS, buildListingEvent(PRODUCT, PAYOUTS, store.secretKey, T0));
    const state = emptyLedger();
    state.terms = publishTerms(
      [],
      { d: PRODUCT.d, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount },
      T0,
      T0,
    );
    return { pool, state };
  }

  it('read the offer problems refuseOffersNotHonoured refuses, from both relay views', async () => {
    const { pool, state } = published('2000000');
    const result = await readOfferProblems(pool, CONFIG, pubkeys, state, products);
    expect(result.problems).toEqual([`course: ${USDC_DEVNET_CAIP19} at 1000000`]);
    expect(result.served).toBe(true);
    const views = await readRelayViews(pool, [OFFER_RELAYS, [...OFFER_RELAYS, INBOX]], pubkeys, [
      PRODUCT.d,
    ]);
    expect(result.views).toEqual(views);
    expect(result).toEqual({
      ...offerProblems(views, [INBOX], 'devnet', [
        { d: PRODUCT.d, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '2000000' },
      ]),
      views,
    });
  });

  it('find nothing to refuse when the relays serve what the ledger records', async () => {
    const { pool, state } = published('1000000');
    const result = await readOfferProblems(pool, CONFIG, pubkeys, state, products);
    expect(result.problems).toEqual([]);
    expect(result.served).toBe(true);
  });

  it('MN8: read the inbox relays too: a listing served only there is judged', async () => {
    const pool = relayPool();
    const wide = buildStoreWideEvents(CONFIG, keys, T0, T0);
    for (const event of [wide.payoutList, ...wide.others]) {
      pool.add([...OFFER_RELAYS, INBOX], event);
    }
    pool.add([INBOX], buildListingEvent(PRODUCT, PAYOUTS, store.secretKey, T0));
    const state = emptyLedger();
    state.terms = publishTerms(
      [],
      { d: PRODUCT.d, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '2000000' },
      T0,
      T0,
    );
    const result = await readOfferProblems(pool, CONFIG, pubkeys, state, products);
    expect(result.problems).toEqual([`course: ${USDC_DEVNET_CAIP19} at 1000000`]);
  });

  /** A store published with `payouts` under `config`, whose ledger records each coin at 1 USD. */
  async function evmOfferProblems(config: MerchantConfig, payouts: MerchantConfig['payouts']) {
    const withPayouts = { ...config, payouts };
    const pool = relayPool();
    const wide = buildStoreWideEvents(withPayouts, keys, T0, T0);
    for (const event of [wide.payoutList, ...wide.others]) {
      pool.add([...OFFER_RELAYS, INBOX], event);
    }
    pool.add(OFFER_RELAYS, buildListingEvent(PRODUCT, payouts, store.secretKey, T0));
    const state = emptyLedger();
    state.terms = payouts.flatMap((payout) =>
      publishTerms(
        [],
        { d: PRODUCT.d, caip19: payout.caip19, payout: payout.address, amount: '1000000' },
        T0,
        T0,
      ),
    );
    return (await readOfferProblems(pool, withPayouts, pubkeys, state, products)).problems;
  }

  it('MN10: honour a Tempo coin only with a Tempo block on its network', async () => {
    const tempoUsdc = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';
    const evmPayout = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
    const payouts = [{ caip19: tempoUsdc, address: evmPayout }];
    const mainnet: MerchantConfig = { ...CONFIG, network: 'mainnet' };
    expect(await evmOfferProblems({ ...mainnet, tempo: { network: 'mainnet' } }, payouts)).toEqual(
      [],
    );
    expect(await evmOfferProblems(mainnet, payouts)).toEqual([`${tempoUsdc} ${evmPayout}`]);
    expect(await evmOfferProblems({ ...mainnet, tempo: { network: 'moderato' } }, payouts)).toEqual(
      [`${tempoUsdc} ${evmPayout}`],
    );
  });

  it('MN11: honour an eip3009 coin only on a chain the evm block verifies', async () => {
    const base = EIP3009_USDC.find(
      (coin) => coin.chain.slug === 'base' && coin.chain.network === 'mainnet',
    );
    if (base === undefined) {
      throw new Error('no Base mainnet USDC in the registry');
    }
    const evmPayout = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
    const payouts = [{ caip19: base.caip19, address: evmPayout }];
    const mainnet: MerchantConfig = { ...CONFIG, network: 'mainnet' };
    expect(
      await evmOfferProblems(
        { ...mainnet, evm: { base: { rpcUrl: 'https://base.example' } } },
        payouts,
      ),
    ).toEqual([]);
    expect(await evmOfferProblems(mainnet, payouts)).toEqual([`${base.caip19} ${evmPayout}`]);
    expect(
      await evmOfferProblems(
        { ...mainnet, evm: { arbitrum: { rpcUrl: 'https://arbitrum.example' } } },
        payouts,
      ),
    ).toEqual([`${base.caip19} ${evmPayout}`]);
  });

  it('say when nothing was served', async () => {
    const result = await readOfferProblems(relayPool(), CONFIG, pubkeys, emptyLedger(), products);
    expect(result).toMatchObject({ problems: [], served: false });
  });

  it('warn about a profile without fee support or marked memos, and not about one with both', () => {
    const bare = finalizeEvent(
      { kind: 0, created_at: T0, tags: [], content: JSON.stringify({ name: 'Shop' }) },
      store.secretKey,
    );
    const view = { listings: [], payoutList: undefined, inboxList: undefined };
    expect(
      profileWarnings([{ ...view, profile: bare }], { kind: 'read', feeBps: 300 }),
    ).toHaveLength(2);
    const [declared] = buildStoreSignedEvents(CONFIG, store.secretKey, owner.pubkey, T0, true);
    expect(
      profileWarnings([{ ...view, profile: declared }], { kind: 'read', feeBps: 300 }),
    ).toEqual([]);
    expect(profileWarnings([view], { kind: 'unreachable', problem: 'down' })).toEqual([]);
  });

  it('refuse a price a payout cannot carry, and a product with a history and no directory', () => {
    expect(productPriceProblems(CONFIG, [PRODUCT])).toBeUndefined();
    expect(productPriceProblems(CONFIG, [{ d: 'tiny', priceUsd: '0.0000001' }])).toBe(
      'the products are not usable:\n- products/tiny: USDC cannot be paid its price of 0.0000001 USD',
    );
    const { state } = published('1000000');
    expect(lostHistoryProblem(state, products)).toBeUndefined();
    expect(lostHistoryProblem(state, new Map())).toMatch(/^product course has a history/);
  });
});

describe('a setup pass', () => {
  const store = key();
  const owner = key();
  const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };
  const relays = [...OFFER_RELAYS, INBOX];
  const payoutsString = JSON.stringify(PAYOUTS);

  function pass(pool: ReturnType<typeof relayPool>, clock: { now: number }, published: string[]) {
    return {
      pool,
      relays,
      defaultRelays: OFFER_RELAYS,
      pubkeys: { storePubkey: store.pubkey, ownerPubkey: owner.pubkey },
      products: new Map([[PRODUCT.d, PRODUCT]]),
      payouts: PAYOUTS,
      payoutsString,
      storeSecretKey: store.secretKey,
      sign: ({ startedAt, paytoCreatedAt }: { startedAt: number; paytoCreatedAt: number }) =>
        buildStoreWideEvents(CONFIG, keys, startedAt, paytoCreatedAt),
      publish: async (event: NostrEvent, name: string) => {
        published.push(name);
        pool.add(relays, event);
        return true;
      },
      now: () => clock.now,
    };
  }

  it('publishes a fresh store and records it, then keeps the payout list date while nothing changed', async () => {
    const pool = relayPool();
    const clock = { now: T0 };
    const published: string[] = [];
    const state = emptyLedger();
    const outcomes = await runSetupPass(state, pass(pool, clock, published));
    expect(published).toEqual([
      'the payout list',
      'products/course',
      'kind 0',
      'kind 10050',
      'kind 30490',
    ]);
    expect(outcomes).toMatchObject([{ d: 'course', listing: 'out' }]);
    expect(state.payto).toEqual({ createdAt: T0, payouts: payoutsString });
    expect(state.resumeAt).toBe(T0);
    expect(state.listings.course?.createdAt).toBe(T0);

    clock.now = T0 + 100;
    published.length = 0;
    const again = await runSetupPass(state, pass(pool, clock, published));
    expect(again).toMatchObject([{ d: 'course', listing: 'unchanged' }]);
    expect(state.payto).toEqual({ createdAt: T0, payouts: payoutsString });
    expect(state.resumeAt).toBe(T0);
  });

  it('records the payout list with the date it was signed with (an owner event signed elsewhere)', async () => {
    const pool = relayPool();
    const state = emptyLedger();
    const committedAt = T0 - 30;
    const committed = finalizeEvent(
      ownerEventTemplates(CONFIG, owner.pubkey, store.pubkey, committedAt, committedAt, {
        mode: 'hosted',
        operator: 'elisym.network',
      }).payoutList,
      owner.secretKey,
    );
    await runSetupPass(state, {
      ...pass(pool, { now: T0 }, []),
      sign: ({ startedAt }) => ({
        payoutList: committed,
        others: buildStoreSignedEvents(CONFIG, store.secretKey, owner.pubkey, startedAt, false),
      }),
    });
    expect(state.payto).toEqual({ createdAt: committedAt, payouts: payoutsString });
  });

  it('refuses a clock behind the last publish before signing or publishing anything', async () => {
    const state = emptyLedger();
    state.payto = { createdAt: T0 + 86_400, payouts: '[]' };
    const published: string[] = [];
    let signed = false;
    await expect(
      runSetupPass(state, {
        ...pass(relayPool(), { now: T0 }, published),
        sign: () => {
          signed = true;
          return buildStoreWideEvents(CONFIG, keys, T0, T0);
        },
      }),
    ).rejects.toThrow('the clock is behind the last publish of the payout list');
    expect(signed).toBe(false);
    expect(published).toEqual([]);
    expect(state.resumeAt).toBeUndefined();
  });

  it('refuses a payout list signed too far ahead of the clock, before publishing anything', async () => {
    const published: string[] = [];
    const ahead = T0 + 86_400;
    await expect(
      runSetupPass(emptyLedger(), {
        ...pass(relayPool(), { now: T0 }, published),
        sign: ({ startedAt }) => buildStoreWideEvents(CONFIG, keys, startedAt, ahead),
      }),
    ).rejects.toThrow('the clock is behind the last publish of the payout list');
    expect(published).toEqual([]);
  });

  /** The owner's payout list paying to `address`, signed elsewhere with `date`. */
  function ownerList(date: number, address: string = PAYOUT): NostrEvent {
    const config = { ...CONFIG, payouts: [{ caip19: USDC_DEVNET_CAIP19, address }] };
    return finalizeEvent(
      ownerEventTemplates(config, owner.pubkey, store.pubkey, date, date, { mode: 'self-host' })
        .payoutList,
      owner.secretKey,
    );
  }

  /** A pass whose payout list is `payoutList`, signed elsewhere. */
  function committedPass(
    pool: ReturnType<typeof relayPool>,
    published: string[],
    payoutList: NostrEvent,
  ) {
    return {
      ...pass(pool, { now: T0 }, published),
      sign: ({ startedAt }: { startedAt: number }) => ({
        payoutList,
        others: buildStoreSignedEvents(CONFIG, store.secretKey, owner.pubkey, startedAt, false),
      }),
    };
  }

  it('refuses a signed payout list older than the one the relays serve, before publishing anything', async () => {
    const pool = relayPool();
    pool.add(relays, ownerList(T0 - 10));
    const published: string[] = [];
    const state = emptyLedger();
    await expect(
      runSetupPass(state, committedPass(pool, published, ownerList(T0 - 30))),
    ).rejects.toThrow(
      `the signed payout list (dated ${T0 - 30}) is older than the one the relays serve (dated ${T0 - 10})`,
    );
    expect(published).toEqual([]);
    expect(state.payto).toBeUndefined();
  });

  it('refuses a signed payout list tied with another one the relays serve, and takes the very one they serve', async () => {
    const pool = relayPool();
    const served = ownerList(T0 - 10, PAYER);
    pool.add(relays, served);
    const published: string[] = [];
    await expect(
      runSetupPass(emptyLedger(), committedPass(pool, published, ownerList(T0 - 10))),
    ).rejects.toThrow(
      `the signed payout list is dated the same second (${T0 - 10}) as another one the relays serve`,
    );
    expect(published).toEqual([]);

    const same = relayPool();
    const list = ownerList(T0 - 10);
    same.add(relays, list);
    const state = emptyLedger();
    await runSetupPass(state, committedPass(same, published, list));
    expect(published[0]).toBe('the payout list');
    expect(state.payto).toEqual({ createdAt: T0 - 10, payouts: payoutsString });
  });

  it('refuses a signed payout list dated as the recorded one but paying to other payouts', async () => {
    const published: string[] = [];
    const state = emptyLedger();
    state.payto = { createdAt: T0 - 30, payouts: '[]' };
    await expect(
      runSetupPass(state, committedPass(relayPool(), published, ownerList(T0 - 30))),
    ).rejects.toThrow(
      `the signed payout list is dated the same second (${T0 - 30}) as the recorded one but pays to other payouts`,
    );
    expect(published).toEqual([]);
    expect(state.payto).toEqual({ createdAt: T0 - 30, payouts: '[]' });

    state.payto = { createdAt: T0 - 30, payouts: payoutsString };
    await runSetupPass(state, committedPass(relayPool(), published, ownerList(T0 - 30)));
    expect(state.payto).toEqual({ createdAt: T0 - 30, payouts: payoutsString });
  });
});

describe('a payout list signed elsewhere', () => {
  const owner = key();
  const store = key();
  const payoutsString = JSON.stringify(PAYOUTS);

  function listAt(date: number): NostrEvent {
    return finalizeEvent(
      ownerEventTemplates(CONFIG, owner.pubkey, store.pubkey, date, date, { mode: 'self-host' })
        .payoutList,
      owner.secretKey,
    );
  }

  it('MN1: is not judged against the clock when it is the recorded list, however far ahead', () => {
    const ahead = T0 + 86_400;
    const state = emptyLedger();
    state.payto = { createdAt: ahead, payouts: payoutsString };
    const signed = { event: listAt(ahead), payouts: payoutsString };
    expect(signedPayoutListProblem(state, signed, undefined, T0)).toBeUndefined();
    expect(signedPayoutListProblem(emptyLedger(), signed, undefined, T0)).toBe(
      'the clock is behind the last publish of the payout list: fix the clock or wait',
    );
    expect(signedPayoutListProblem(state, { ...signed, payouts: '[]' }, undefined, T0)).toMatch(
      /as the recorded one but pays to other payouts/,
    );
  });

  it('is refused as older when the relays serve one dated a single second later', () => {
    const newest = listAt(T0 - 10);
    const signed = { event: listAt(T0 - 11), payouts: payoutsString };
    expect(signedPayoutListProblem(emptyLedger(), signed, newest, T0)).toBe(
      `the signed payout list (dated ${T0 - 11}) is older than the one the relays serve (dated ${T0 - 10}): buyers would not be served it; sign it with a later date`,
    );
    const later = { event: listAt(T0 - 9), payouts: payoutsString };
    expect(signedPayoutListProblem(emptyLedger(), later, newest, T0)).toBeUndefined();
  });
});
