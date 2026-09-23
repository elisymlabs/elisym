import type { Filter, NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import type { DomainKeys } from '../src/domain';
import { buildPaytoEvent } from '../src/events/payto';
import { buildProductEvent, encodeProductNaddr } from '../src/events/product';
import { buildStoreAuthEvent, buildStoreRevocationEvent } from '../src/events/store-auth';
import { buildStoreProfileEvent } from '../src/events/store-profile';
import {
  type EvaluateOfferOptions,
  type OfferBundle,
  type OfferVerification,
  type VerifiedOffer,
  evaluateOffer,
  isOfferPayout,
  verifyOffer,
} from '../src/verify-offer';
import {
  USDC_DEVNET_CAIP19,
  USDC_MAINNET_CAIP19,
  type NostrKey,
  type SolanaWallet,
  nostrKey,
  sign,
  solanaWallet,
} from './fixtures';

const T0 = 1_750_000_000;
const DAY = 24 * 60 * 60;
const NOW = T0 + 10 * DAY;
const D = 'course-101';
const DOMAIN = 'shop.example';

interface World {
  owner: NostrKey;
  store: NostrKey;
  wallet: SolanaWallet;
  product: NostrEvent;
  profile: NostrEvent;
  payto: NostrEvent;
  auth: NostrEvent;
  domainKeys: DomainKeys;
}

function makeWorld(profile: { nip05?: string; withOwnerTag?: boolean } = {}): World {
  const owner = nostrKey();
  const store = nostrKey();
  const wallet = solanaWallet();
  const profileTemplate = buildStoreProfileEvent({
    name: 'Shop',
    ownerPubkey: owner.pubkey,
    createdAt: T0,
    ...(profile.nip05 === undefined ? {} : { nip05: profile.nip05 }),
  });
  if (profile.withOwnerTag === false) {
    profileTemplate.tags = [];
  }
  return {
    owner,
    store,
    wallet,
    product: sign(
      buildProductEvent({
        d: D,
        title: 'Agents 101',
        description: 'Twelve lessons.',
        price: { amount: '49', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0,
      }),
      store,
    ),
    profile: sign(profileTemplate, store),
    payto: sign(
      buildPaytoEvent({
        accept: [
          {
            caip19: USDC_DEVNET_CAIP19,
            address: wallet.address,
            signature: wallet.proveFor(owner.pubkey, USDC_DEVNET_CAIP19),
          },
        ],
        createdAt: T0,
      }),
      owner,
    ),
    auth: sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: T0 }),
      owner,
    ),
    domainKeys: {
      domain: DOMAIN,
      storePubkey: store.pubkey,
      ownerPubkey: owner.pubkey,
      source: 'nostr.json',
    },
  };
}

function pointerOf(world: World): { storePubkey: string; d: string } {
  return { storePubkey: world.store.pubkey, d: D };
}

function evaluate(
  world: World,
  bundle: Partial<OfferBundle> & { events?: readonly NostrEvent[] } = {},
  options: EvaluateOfferOptions = {},
): OfferVerification {
  return evaluateOffer(
    pointerOf(world),
    { events: bundle.events ?? [world.product, world.profile, world.payto, world.auth], ...bundle },
    { now: NOW, ...options },
  );
}

function expectOffer(result: OfferVerification): VerifiedOffer {
  if (!result.ok) {
    throw new Error(`expected an offer, got ${result.refusal}: ${result.message}`);
  }
  return result.offer;
}

function expectRefusal(result: OfferVerification): string {
  if (result.ok) {
    throw new Error(`expected a refusal, got a level ${result.offer.level} offer`);
  }
  return result.refusal;
}

describe('evaluateOffer - level C (keys only)', () => {
  it('verifies an offer whose owner is named by the store and authorizes it', () => {
    const world = makeWorld();
    const offer = expectOffer(evaluate(world));
    expect(offer.level).toBe('C');
    expect(offer.domain).toBeUndefined();
    expect(offer.ownerPubkey).toBe(world.owner.pubkey);
    expect(offer.product.title).toBe('Agents 101');
    expect(offer.payouts.map((target) => target.address)).toEqual([world.wallet.address]);
    expect(offer.warnings).toEqual([]);
  });

  it('refuses without an AUTH from the owner: a store cannot adopt an owner on its own', () => {
    const world = makeWorld();
    expect(
      expectRefusal(evaluate(world, { events: [world.product, world.profile, world.payto] })),
    ).toBe('store_auth_missing');
  });

  it('refuses an AUTH signed by someone other than the owner', () => {
    const world = makeWorld();
    const stranger = nostrKey();
    const foreignAuth = sign(
      buildStoreAuthEvent({ storePubkey: world.store.pubkey, mode: 'self-host' }),
      stranger,
    );
    expect(
      expectRefusal(
        evaluate(world, { events: [world.product, world.profile, world.payto, foreignAuth] }),
      ),
    ).toBe('store_auth_missing');
  });

  it('refuses an expired AUTH, and a revocation newer than the AUTH', () => {
    const world = makeWorld();
    const expired = sign(
      buildStoreAuthEvent({
        storePubkey: world.store.pubkey,
        mode: 'self-host',
        expiresAt: NOW - 1,
        createdAt: T0 + 1,
      }),
      world.owner,
    );
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, world.profile, world.payto, world.auth, expired],
        }),
      ),
    ).toBe('store_auth_expired');
    const revoked = sign(buildStoreRevocationEvent(world.store.pubkey, T0 + 1), world.owner);
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, world.profile, world.payto, world.auth, revoked],
        }),
      ),
    ).toBe('store_auth_revoked');
  });

  it('refuses when nothing names an owner', () => {
    const world = makeWorld({ withOwnerTag: false });
    expect(expectRefusal(evaluate(world))).toBe('owner_unknown');
  });

  it('refuses an owner other than the one pinned at the first purchase', () => {
    const world = makeWorld();
    expect(expectRefusal(evaluate(world, {}, { pinnedOwnerPubkey: 'f'.repeat(64) }))).toBe(
      'owner_pin_mismatch',
    );
    expect(expectOffer(evaluate(world, {}, { pinnedOwnerPubkey: world.owner.pubkey })).level).toBe(
      'C',
    );
  });
});

describe('evaluateOffer - level A (domain)', () => {
  it('verifies an offer whose domain names both keys, with no AUTH needed', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const offer = expectOffer(
      evaluate(world, {
        events: [world.product, world.profile, world.payto],
        domain: world.domainKeys,
      }),
    );
    expect(offer.level).toBe('A');
    expect(offer.domain).toBe(DOMAIN);
  });

  it('still honours a revocation at level A', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const revoked = sign(buildStoreRevocationEvent(world.store.pubkey, T0 + 1), world.owner);
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, world.profile, world.payto, revoked],
          domain: world.domainKeys,
        }),
      ),
    ).toBe('store_auth_revoked');
  });

  it('refuses a store its domain does not name: a copied nip05 is not an identity', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    expect(
      expectRefusal(
        evaluate(world, { domain: { ...world.domainKeys, storePubkey: 'f'.repeat(64) } }),
      ),
    ).toBe('domain_mismatch');
  });

  it('refuses when the profile and the domain name different owners', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    expect(
      expectRefusal(
        evaluate(world, { domain: { ...world.domainKeys, ownerPubkey: 'f'.repeat(64) } }),
      ),
    ).toBe('owner_mismatch');
  });

  it('takes the payout addresses of the DOMAIN owner, never of an owner the profile names', () => {
    // The store key is stolen and the profile now points at the attacker's owner key,
    // with the attacker's 10133 and AUTH. The domain still names the real owner.
    const world = makeWorld({ nip05: `_@${DOMAIN}`, withOwnerTag: false });
    const attacker = nostrKey();
    const attackerWallet = solanaWallet();
    const attackerPayto = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: attackerWallet.address }],
        createdAt: T0 + 5,
      }),
      attacker,
    );
    const offer = expectOffer(
      evaluate(world, {
        events: [world.product, world.profile, world.payto, attackerPayto],
        domain: world.domainKeys,
      }),
    );
    expect(offer.payouts.map((target) => target.address)).toEqual([world.wallet.address]);
  });

  it('falls back to level C with a warning when the domain does not answer', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const offer = expectOffer(evaluate(world, { domain: 'unreachable' }));
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
  });

  describe('the page embedding the widget', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const bundle = {
      events: [world.product, world.profile, world.payto],
      domain: world.domainKeys,
    };

    it('passes on the domain and its subdomains', () => {
      for (const pageOrigin of [`https://${DOMAIN}`, `https://www.${DOMAIN}`]) {
        expect(expectOffer(evaluate(world, bundle, { pageOrigin })).warnings).toEqual([]);
      }
    });

    it('warns on another site, and on a look-alike or plain-http one', () => {
      for (const pageOrigin of [
        'https://evil.example',
        `https://${DOMAIN}.evil.example`,
        `http://${DOMAIN}`,
        'nonsense',
      ]) {
        expect(expectOffer(evaluate(world, bundle, { pageOrigin })).warnings).toContain(
          'origin_mismatch',
        );
      }
    });

    it('refuses on another site in strict mode', () => {
      expect(
        expectRefusal(
          evaluate(world, bundle, { pageOrigin: 'https://evil.example', strictOrigin: true }),
        ),
      ).toBe('origin_mismatch');
    });

    it('cannot compare the page at level C', () => {
      const keysOnly = makeWorld();
      expect(
        expectOffer(evaluate(keysOnly, {}, { pageOrigin: 'https://any.example' })).warnings,
      ).toContain('origin_unverifiable');
    });
  });
});

describe('evaluateOffer - level B (hosted name)', () => {
  it('is B when the hosted registrar names the store, and still needs the AUTH', () => {
    const world = makeWorld({ nip05: 'shop@elisym.shop' });
    const hostedKeys: DomainKeys = {
      domain: 'elisym.shop',
      storePubkey: world.store.pubkey,
      source: 'nostr.json',
    };
    const options = { hostedDomains: ['elisym.shop'] };
    const offer = expectOffer(evaluate(world, { domain: hostedKeys }, options));
    expect(offer.level).toBe('B');
    expect(offer.domain).toBe('elisym.shop');
    expect(
      expectRefusal(
        evaluate(
          world,
          { events: [world.product, world.profile, world.payto], domain: hostedKeys },
          options,
        ),
      ),
    ).toBe('store_auth_missing');
  });
});

describe('evaluateOffer - the listing and the profile', () => {
  it('refuses a missing listing, one signed by another key, and one with another d', () => {
    const world = makeWorld();
    expect(
      expectRefusal(evaluate(world, { events: [world.profile, world.payto, world.auth] })),
    ).toBe('product_missing');
    const byOther = sign(
      buildProductEvent({
        d: D,
        title: 'X',
        description: '',
        price: { amount: '1', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
      }),
      nostrKey(),
    );
    expect(
      expectRefusal(evaluate(world, { events: [byOther, world.profile, world.payto, world.auth] })),
    ).toBe('product_missing');
    expect(
      expectRefusal(
        evaluateOffer(
          { storePubkey: world.store.pubkey, d: 'other' },
          { events: [world.product, world.profile, world.payto, world.auth] },
          { now: NOW },
        ),
      ),
    ).toBe('product_missing');
  });

  it('ignores a listing whose signature was forged', () => {
    const world = makeWorld();
    const forged = { ...world.product, content: 'tampered' };
    expect(
      expectRefusal(evaluate(world, { events: [forged, world.profile, world.payto, world.auth] })),
    ).toBe('product_missing');
  });

  it('refuses a hidden listing', () => {
    const world = makeWorld();
    const hidden = sign(
      buildProductEvent({
        d: D,
        title: 'X',
        description: '',
        price: { amount: '1', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        visibility: 'hidden',
        createdAt: T0 + 1,
      }),
      world.store,
    );
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, hidden, world.profile, world.payto, world.auth],
        }),
      ),
    ).toBe('product_not_on_sale');
  });

  it('refuses without a store profile', () => {
    const world = makeWorld();
    expect(
      expectRefusal(evaluate(world, { events: [world.product, world.payto, world.auth] })),
    ).toBe('store_profile_missing');
  });
});

describe('evaluateOffer - payout addresses', () => {
  it('refuses when the owner published none', () => {
    const world = makeWorld();
    expect(
      expectRefusal(evaluate(world, { events: [world.product, world.profile, world.auth] })),
    ).toBe('payto_missing');
  });

  it("ignores a 10133 from anyone but the owner, even the store's own key", () => {
    const world = makeWorld();
    const storePayto = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
      }),
      world.store,
    );
    expect(
      expectRefusal(
        evaluate(world, { events: [world.product, world.profile, world.auth, storePayto] }),
      ),
    ).toBe('payto_missing');
  });

  it('refuses when no payout address fits an asset the product accepts', () => {
    const world = makeWorld();
    const mainnetOnly = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_MAINNET_CAIP19, address: world.wallet.address }],
        createdAt: T0 + 1,
      }),
      world.owner,
    );
    expect(
      expectRefusal(
        evaluate(world, { events: [world.product, world.profile, world.auth, mainnetOnly] }),
      ),
    ).toBe('no_payout_for_accepted_assets');
  });

  it('takes the newest genuine 10133 and ignores a forged newer one', () => {
    const world = makeWorld();
    const next = solanaWallet();
    const newer = sign(
      buildPaytoEvent({
        accept: [
          {
            caip19: USDC_DEVNET_CAIP19,
            address: next.address,
            signature: next.proveFor(world.owner.pubkey, USDC_DEVNET_CAIP19),
          },
        ],
        createdAt: T0 + 1,
      }),
      world.owner,
    );
    const offer = expectOffer(
      evaluate(world, { events: [world.product, world.profile, world.auth, world.payto, newer] }),
    );
    expect(offer.payouts.map((target) => target.address)).toEqual([next.address]);

    const forged: NostrEvent = {
      ...world.payto,
      created_at: T0 + 2,
      tags: [['accept', USDC_DEVNET_CAIP19, solanaWallet().address]],
    };
    const kept = expectOffer(
      evaluate(world, { events: [world.product, world.profile, world.auth, world.payto, forged] }),
    );
    expect(kept.payouts.map((target) => target.address)).toEqual([world.wallet.address]);
  });

  it('ignores an event dated in the future, so it cannot pin itself as newest', () => {
    const world = makeWorld();
    const future = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
        createdAt: NOW + DAY,
      }),
      world.owner,
    );
    const offer = expectOffer(
      evaluate(world, { events: [world.product, world.profile, world.auth, world.payto, future] }),
    );
    expect(offer.payouts.map((target) => target.address)).toEqual([world.wallet.address]);
  });

  it('warns about a payout event younger than the cool-down, and about an unsigned address', () => {
    const world = makeWorld();
    const fresh = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: world.wallet.address }],
        createdAt: NOW - 60,
      }),
      world.owner,
    );
    const offer = expectOffer(
      evaluate(world, { events: [world.product, world.profile, world.auth, fresh] }),
    );
    expect(offer.warnings).toEqual(['payout_recently_changed', 'payout_unsigned']);
  });
});

describe('isOfferPayout (step 9)', () => {
  const world = makeWorld();
  const offer = expectOffer(evaluate(world));

  it('accepts only the owner address for that exact asset', () => {
    expect(isOfferPayout(offer, USDC_DEVNET_CAIP19, world.wallet.address)).toBe(true);
    expect(isOfferPayout(offer, USDC_DEVNET_CAIP19, solanaWallet().address)).toBe(false);
    expect(isOfferPayout(offer, USDC_MAINNET_CAIP19, world.wallet.address)).toBe(false);
    expect(isOfferPayout(offer, 'garbage', world.wallet.address)).toBe(false);
  });
});

function matches(event: NostrEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  const dValues = filter['#d'];
  if (dValues && !event.tags.some((tag) => tag[0] === 'd' && dValues.includes(tag[1] ?? ''))) {
    return false;
  }
  return true;
}

describe('verifyOffer', () => {
  it('collects the events from relays and the domain, and verifies', async () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const relayEvents = [world.product, world.profile, world.payto, world.auth];
    const queried: Filter[][] = [];
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        fetchEvents: async (filters) => {
          queried.push(filters);
          return relayEvents.filter((event) => filters.some((filter) => matches(event, filter)));
        },
        resolveDomain: async (nip05) => (nip05 === `_@${DOMAIN}` ? world.domainKeys : undefined),
      },
      { now: NOW },
    );
    expect(expectOffer(result).level).toBe('A');
    expect(queried).toHaveLength(2);
    expect(queried[1]?.[0]?.authors).toEqual([world.owner.pubkey]);
  });

  it('marks a silent domain unreachable and falls back to level C', async () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const relayEvents = [world.product, world.profile, world.payto, world.auth];
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        fetchEvents: async (filters) =>
          relayEvents.filter((event) => filters.some((filter) => matches(event, filter))),
        resolveDomain: async () => undefined,
      },
      { now: NOW },
    );
    const offer = expectOffer(result);
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
  });

  it('refuses something that is not a product naddr', async () => {
    const result = await verifyOffer('npub1nope', { fetchEvents: async () => [] });
    expect(expectRefusal(result)).toBe('bad_pointer');
  });
});
