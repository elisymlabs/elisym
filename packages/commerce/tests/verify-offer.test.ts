import type { Filter, NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import type { DomainKeys } from '../src/domain';
import { buildPaytoEvent } from '../src/events/payto';
import { buildProductEvent, encodeProductNaddr } from '../src/events/product';
import {
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  storeAuthAddress,
} from '../src/events/store-auth';
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
        ownerPubkey: owner.pubkey,
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
      name: '_',
      storePubkey: store.pubkey,
      ownerPubkey: owner.pubkey,
      source: 'nostr.json',
    },
  };
}

function deletionOfAuth(
  world: World,
  createdAt: number,
  signer: NostrKey = world.owner,
): NostrEvent {
  return sign(
    {
      kind: 5,
      created_at: createdAt,
      tags: [['a', storeAuthAddress(world.owner.pubkey, world.store.pubkey)]],
      content: '',
    },
    signer,
  );
}

function allEvents(world: World): NostrEvent[] {
  return [world.product, world.profile, world.payto, world.auth];
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
    // Nothing but the store-signed profile names the owner until it is pinned.
    expect(offer.warnings).toEqual(['owner_unpinned']);
    expect(
      expectOffer(evaluate(world, {}, { pinnedOwnerPubkey: world.owner.pubkey })).warnings,
    ).toEqual([]);
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
      buildStoreAuthEvent({
        storePubkey: world.store.pubkey,
        mode: 'self-host',
        createdAt: T0 + 1,
      }),
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

  it('refuses in strict mode: no domain means nothing to match the page against', () => {
    const world = makeWorld();
    expect(
      expectRefusal(
        evaluate(world, {}, { pageOrigin: 'https://evil.example', strictOrigin: true }),
      ),
    ).toBe('origin_mismatch');
  });
});

describe('evaluateOffer - NIP-09 revocation', () => {
  it('revokes the AUTH with a deletion of its address that is not older than it', () => {
    const world = makeWorld();
    for (const createdAt of [T0, T0 + 1]) {
      expect(
        expectRefusal(
          evaluate(world, { events: [...allEvents(world), deletionOfAuth(world, createdAt)] }),
        ),
      ).toBe('store_auth_revoked');
    }
  });

  it('revokes even when the revocation is dated past the skew window (a fast clock)', () => {
    const world = makeWorld();
    const ahead = NOW + 20 * 60;
    const revoked = sign(buildStoreRevocationEvent(world.store.pubkey, ahead), world.owner);
    expect(expectRefusal(evaluate(world, { events: [...allEvents(world), revoked] }))).toBe(
      'store_auth_revoked',
    );
    expect(
      expectRefusal(
        evaluate(world, { events: [...allEvents(world), deletionOfAuth(world, ahead)] }),
      ),
    ).toBe('store_auth_revoked');
  });

  it('lets an AUTH issued after the deletion stand', () => {
    const world = makeWorld();
    const reissued = sign(
      buildStoreAuthEvent({
        storePubkey: world.store.pubkey,
        mode: 'self-host',
        createdAt: T0 + 2,
      }),
      world.owner,
    );
    const offer = expectOffer(
      evaluate(world, {
        events: [...allEvents(world), deletionOfAuth(world, T0 + 1), reissued],
      }),
    );
    expect(offer.level).toBe('C');
  });

  it('ignores a deletion signed by anyone but the owner, and a forged one', () => {
    const world = makeWorld();
    const byStore = deletionOfAuth(world, T0 + 1, world.store);
    const forged = { ...deletionOfAuth(world, T0 + 1), content: 'x' };
    expect(evaluate(world, { events: [...allEvents(world), byStore, forged] }).ok).toBe(true);
  });

  it('stands at level A too', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, world.profile, world.payto, deletionOfAuth(world, T0 + 1)],
          domain: world.domainKeys,
        }),
      ),
    ).toBe('store_auth_revoked');
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

  it('honours a revocation with no `p` tag at level A, and refuses on a malformed newest AUTH', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const bareRevocation = sign(
      {
        kind: 30490,
        created_at: T0 + 5,
        tags: [
          ['d', world.store.pubkey],
          ['mode', 'revoked'],
        ],
        content: '',
      },
      world.owner,
    );
    const unreadable = sign(
      {
        kind: 30490,
        created_at: T0 + 5,
        tags: [
          ['d', world.store.pubkey],
          ['p', world.store.pubkey],
          ['mode', 'self-host'],
          ['expiration', 'soon'],
        ],
        content: '',
      },
      world.owner,
    );
    const at = (event: NostrEvent): OfferVerification =>
      evaluate(world, { events: [...allEvents(world), event], domain: world.domainKeys });
    expect(expectRefusal(at(bareRevocation))).toBe('store_auth_revoked');
    expect(expectRefusal(at(unreadable))).toBe('store_auth_missing');
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

  it('never takes an owner the domain answer alone names: the profile must agree', () => {
    // The domain answer is unsigned. A resolver that forges it for a profile
    // with no owner tag must not get to pick the owner.
    const world = makeWorld({ nip05: `_@${DOMAIN}`, withOwnerTag: false });
    const attacker = nostrKey();
    const forged: DomainKeys = { ...world.domainKeys, ownerPubkey: attacker.pubkey, source: 'dns' };
    const attackerPayto = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
        createdAt: T0 + 5,
      }),
      attacker,
    );
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, world.profile, world.payto, attackerPayto],
          domain: forged,
        }),
      ),
    ).toBe('owner_unknown');
  });

  it('holds the owner pin at level A: a stolen store key can bring its own domain', () => {
    const world = makeWorld();
    const thief = nostrKey();
    const thiefProfile = sign(
      buildStoreProfileEvent({
        name: 'Shop',
        ownerPubkey: thief.pubkey,
        nip05: '_@evil.example',
        createdAt: T0 + 1,
      }),
      world.store,
    );
    const thiefPayto = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
        createdAt: T0,
      }),
      thief,
    );
    const bundle = {
      events: [world.product, world.profile, thiefProfile, thiefPayto],
      domain: {
        domain: 'evil.example',
        name: '_',
        storePubkey: world.store.pubkey,
        ownerPubkey: thief.pubkey,
        source: 'dns' as const,
      },
    };
    expect(expectOffer(evaluate(world, bundle)).level).toBe('A');
    expect(expectRefusal(evaluate(world, bundle, { pinnedOwnerPubkey: world.owner.pubkey }))).toBe(
      'owner_pin_mismatch',
    );
  });

  it('refuses a profile a stolen store key pointed at another owner than the domain names', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const attacker = nostrKey();
    const stolenProfile = sign(
      buildStoreProfileEvent({
        name: 'Shop',
        ownerPubkey: attacker.pubkey,
        nip05: `_@${DOMAIN}`,
        createdAt: T0 + 5,
      }),
      world.store,
    );
    const attackerPayto = sign(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
        createdAt: T0 + 5,
      }),
      attacker,
    );
    expect(
      expectRefusal(
        evaluate(world, {
          events: [world.product, stolenProfile, world.payto, attackerPayto],
          domain: world.domainKeys,
        }),
      ),
    ).toBe('owner_mismatch');
  });

  it('skips a malformed event instead of throwing', () => {
    const world = makeWorld();
    const broken = JSON.parse(
      JSON.stringify({ ...world.product, tags: null, created_at: T0 + 9 }),
    ) as NostrEvent;
    expect(expectOffer(evaluate(world, { events: [broken, ...allEvents(world)] })).level).toBe('C');
  });

  it('is not A under a name other than `_`: `owner@` on a shared host is anyone', () => {
    const attacker = nostrKey();
    const shared = (world: World): DomainKeys => ({
      domain: 'provider.example',
      name: 'alice',
      storePubkey: world.store.pubkey,
      ownerPubkey: attacker.pubkey,
      source: 'nostr.json',
    });
    const withOwner = makeWorld({ nip05: 'alice@provider.example' });
    const offer = expectOffer(evaluate(withOwner, { domain: shared(withOwner) }));
    expect(offer.level).toBe('C');
    expect(offer.ownerPubkey).toBe(withOwner.owner.pubkey);
    expect(offer.warnings).toContain('domain_unverified');
    const noOwner = makeWorld({ nip05: 'alice@provider.example', withOwnerTag: false });
    expect(expectRefusal(evaluate(noOwner, { domain: shared(noOwner) }))).toBe('owner_unknown');
  });

  it('never lends an answer for one name to a profile that claims another', () => {
    // Looked up for `alice@`, judged for `_@`: a relay that hands the two
    // queries different profiles must not turn a shared host into level A.
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const offer = expectOffer(evaluate(world, { domain: { ...world.domainKeys, name: 'alice' } }));
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
  });

  it('is A under any name when the keys come from the domain TXT record', () => {
    const world = makeWorld({ nip05: `alice@${DOMAIN}` });
    const offer = expectOffer(
      evaluate(world, {
        events: [world.product, world.profile, world.payto],
        domain: { ...world.domainKeys, name: 'alice', source: 'dns' },
      }),
    );
    expect(offer.level).toBe('A');
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
        const pinned = { pageOrigin, pinnedOwnerPubkey: world.owner.pubkey };
        expect(expectOffer(evaluate(world, bundle, pinned)).warnings).toEqual([]);
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

    it('refuses in strict mode when the page origin is not given at all', () => {
      expect(expectRefusal(evaluate(world, bundle, { strictOrigin: true }))).toBe(
        'origin_mismatch',
      );
    });

    it('warns at level A too until the owner is pinned', () => {
      expect(expectOffer(evaluate(world, bundle)).warnings).toEqual(['owner_unpinned']);
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
      name: 'shop',
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

  it('holds the owner pin: a stolen store key cannot name a new owner', () => {
    const world = makeWorld({ nip05: 'shop@elisym.shop' });
    const hostedKeys: DomainKeys = {
      domain: 'elisym.shop',
      name: 'shop',
      storePubkey: world.store.pubkey,
      source: 'nostr.json',
    };
    expect(
      expectRefusal(
        evaluate(
          world,
          { domain: hostedKeys },
          { hostedDomains: ['elisym.shop'], pinnedOwnerPubkey: 'f'.repeat(64) },
        ),
      ),
    ).toBe('owner_pin_mismatch');
  });

  it('warns at level B until the owner is pinned: the registrar vouches for the store only', () => {
    const world = makeWorld({ nip05: 'shop@elisym.shop' });
    const hostedKeys: DomainKeys = {
      domain: 'elisym.shop',
      name: 'shop',
      storePubkey: world.store.pubkey,
      source: 'nostr.json',
    };
    const offer = expectOffer(
      evaluate(world, { domain: hostedKeys }, { hostedDomains: ['elisym.shop'] }),
    );
    expect(offer.level).toBe('B');
    expect(offer.warnings).toEqual(['owner_unpinned']);
  });

  it("does not refuse over the domain TXT record's own store when nostr.json was down", () => {
    const world = makeWorld({ nip05: 'shop@elisym.shop' });
    const registrarStore: DomainKeys = {
      domain: 'elisym.shop',
      name: 'shop',
      storePubkey: 'f'.repeat(64),
      source: 'dns',
    };
    const offer = expectOffer(
      evaluate(world, { domain: registrarStore }, { hostedDomains: ['elisym.shop'] }),
    );
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
  });

  it('reads a domain answer that names no store as no verdict, not as another store', () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const ownerOnly: DomainKeys = {
      domain: DOMAIN,
      name: '_',
      ownerPubkey: world.owner.pubkey,
      source: 'nostr.json',
    };
    const offer = expectOffer(evaluate(world, { domain: ownerOnly }));
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
  });

  it('warns when the hosted name does not answer', () => {
    const world = makeWorld({ nip05: 'shop@elisym.shop' });
    const offer = expectOffer(
      evaluate(world, { domain: 'unreachable' }, { hostedDomains: ['elisym.shop'] }),
    );
    expect(offer.level).toBe('C');
    expect(offer.warnings).toContain('domain_unverified');
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
        createdAt: T0 + 1,
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

  it('refuses a listing the store deleted (NIP-09), unless it was republished after', () => {
    const world = makeWorld();
    const deleteListing = (createdAt: number): NostrEvent =>
      sign(
        {
          kind: 5,
          created_at: createdAt,
          tags: [['a', `30402:${world.store.pubkey}:${D}`]],
          content: '',
        },
        world.store,
      );
    expect(
      expectRefusal(evaluate(world, { events: [...allEvents(world), deleteListing(T0 + 1)] })),
    ).toBe('product_missing');
    expect(evaluate(world, { events: [...allEvents(world), deleteListing(T0 - 1)] }).ok).toBe(true);
    const byOwner = sign(
      {
        kind: 5,
        created_at: T0 + 1,
        tags: [['a', `30402:${world.store.pubkey}:${D}`]],
        content: '',
      },
      world.owner,
    );
    expect(evaluate(world, { events: [...allEvents(world), byOwner] }).ok).toBe(true);
  });

  it('warns about a nip05 that is not a public name at all', () => {
    const world = makeWorld({ nip05: '_@localhost' });
    expect(expectOffer(evaluate(world)).warnings).toContain('domain_unverified');
  });

  it('refuses without a store profile', () => {
    const world = makeWorld();
    expect(
      expectRefusal(evaluate(world, { events: [world.product, world.payto, world.auth] })),
    ).toBe('store_profile_missing');
  });
});

describe('evaluateOffer - payout addresses', () => {
  it('honours NIP-40 on the 10133, the listing and the profile', () => {
    const world = makeWorld();
    const expiring = (event: NostrEvent, value: string, signer: NostrKey): NostrEvent =>
      sign(
        {
          kind: event.kind,
          created_at: event.created_at,
          tags: [...event.tags, ['expiration', value]],
          content: event.content,
        },
        signer,
      );
    const past = String(NOW - 1);
    const future = String(NOW + DAY);
    const swap = (from: NostrEvent, to: NostrEvent): NostrEvent[] =>
      allEvents(world).map((event) => (event === from ? to : event));
    expect(
      expectRefusal(
        evaluate(world, { events: swap(world.payto, expiring(world.payto, past, world.owner)) }),
      ),
    ).toBe('payto_missing');
    expect(
      expectRefusal(
        evaluate(world, {
          events: swap(world.product, expiring(world.product, past, world.store)),
        }),
      ),
    ).toBe('product_missing');
    expect(
      expectRefusal(
        evaluate(world, {
          events: swap(world.profile, expiring(world.profile, past, world.store)),
        }),
      ),
    ).toBe('store_profile_missing');
    // An unreadable expiration fails closed; a future one changes nothing.
    expect(
      expectRefusal(
        evaluate(world, { events: swap(world.payto, expiring(world.payto, 'soon', world.owner)) }),
      ),
    ).toBe('payto_missing');
    expect(
      evaluate(world, { events: swap(world.payto, expiring(world.payto, future, world.owner)) }).ok,
    ).toBe(true);
  });

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
        createdAt: T0 + 1,
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
        ownerPubkey: world.owner.pubkey,
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
    expect(offer.warnings).toEqual([
      'owner_unpinned',
      'payout_recently_changed',
      'payout_unsigned',
    ]);
  });

  it('is not fooled by a back-dated 10133 when the caller knows better', () => {
    // A thief with the owner key dates the new 10133 just after the old one.
    const world = makeWorld();
    const thiefWallet = solanaWallet();
    const backDated = sign(
      buildPaytoEvent({
        ownerPubkey: world.owner.pubkey,
        accept: [
          {
            caip19: USDC_DEVNET_CAIP19,
            address: thiefWallet.address,
            signature: thiefWallet.proveFor(world.owner.pubkey, USDC_DEVNET_CAIP19),
          },
        ],
        createdAt: T0 + 1,
      }),
      world.owner,
    );
    const events = [world.product, world.profile, world.auth, world.payto, backDated];
    const pinned = { pinnedOwnerPubkey: world.owner.pubkey };
    expect(expectOffer(evaluate(world, { events }, pinned)).warnings).toEqual([]);
    expect(
      expectOffer(evaluate(world, { events }, { ...pinned, paytoFirstSeenAt: NOW - 60 })).warnings,
    ).toEqual(['payout_recently_changed']);
    const known = [{ caip19: USDC_DEVNET_CAIP19, address: world.wallet.address }];
    expect(
      expectOffer(evaluate(world, { events }, { ...pinned, knownPayouts: known })).warnings,
    ).toEqual(['payout_changed']);
    expect(expectOffer(evaluate(world, {}, { ...pinned, knownPayouts: known })).warnings).toEqual(
      [],
    );
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
  for (const name of ['d', 'a'] as const) {
    const values = filter[`#${name}`];
    if (values && !event.tags.some((tag) => tag[0] === name && values.includes(tag[1] ?? ''))) {
      return false;
    }
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
    expect(queried[0]?.[2]?.['#a']).toEqual([`30402:${world.store.pubkey}:${D}`]);
    expect(queried[1]?.[2]?.['#a']).toEqual([
      storeAuthAddress(world.owner.pubkey, world.store.pubkey),
    ]);
  });

  it('finds a NIP-09 revocation on the relays', async () => {
    const world = makeWorld();
    const relayEvents = [...allEvents(world), deletionOfAuth(world, T0 + 1)];
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        fetchEvents: async (filters) =>
          relayEvents.filter((event) => filters.some((filter) => matches(event, filter))),
      },
      { now: NOW },
    );
    expect(expectRefusal(result)).toBe('store_auth_revoked');
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

  it('never hands a custom resolver a nip05 that is not a public host', async () => {
    const world = makeWorld({ nip05: '_@127.0.0.0x1' });
    const relayEvents = allEvents(world);
    const asked: string[] = [];
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        fetchEvents: async (filters) =>
          relayEvents.filter((event) => filters.some((filter) => matches(event, filter))),
        resolveDomain: async (nip05) => {
          asked.push(nip05);
          return undefined;
        },
      },
      { now: NOW },
    );
    expect(asked).toEqual([]);
    expect(expectOffer(result).warnings).toContain('domain_unverified');
  });

  it('reads a custom resolver that throws as an unreachable domain', async () => {
    const world = makeWorld({ nip05: `_@${DOMAIN}` });
    const relayEvents = allEvents(world);
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        fetchEvents: async (filters) =>
          relayEvents.filter((event) => filters.some((filter) => matches(event, filter))),
        resolveDomain: async () => {
          throw new Error('lookup failed');
        },
      },
      { now: NOW },
    );
    expect(expectOffer(result).warnings).toContain('domain_unverified');
  });

  it('judges the profile whose domain it looked up, whatever the owner query brings', async () => {
    const world = makeWorld({ nip05: 'alice@provider.example' });
    const claimsDomain = sign(
      buildStoreProfileEvent({
        name: 'Shop',
        ownerPubkey: world.owner.pubkey,
        nip05: '_@provider.example',
        createdAt: T0 + 1,
      }),
      world.store,
    );
    const asked: string[] = [];
    let query = 0;
    const result = await verifyOffer(
      encodeProductNaddr({ storePubkey: world.store.pubkey, d: D }),
      {
        // A relay in the attacker's hands: the older profile first, the newer one later.
        fetchEvents: async () => {
          query += 1;
          return query === 1
            ? [world.product, world.profile]
            : [world.payto, world.auth, claimsDomain];
        },
        resolveDomain: async (nip05) => {
          asked.push(nip05);
          return {
            domain: 'provider.example',
            name: 'alice',
            storePubkey: world.store.pubkey,
            ownerPubkey: world.owner.pubkey,
            source: 'nostr.json',
          };
        },
      },
      { now: NOW },
    );
    expect(asked).toEqual(['alice@provider.example']);
    const offer = expectOffer(result);
    expect(offer.level).toBe('C');
    expect(offer.profile.nip05).toBe('alice@provider.example');
  });

  it('refuses something that is not a product naddr', async () => {
    const result = await verifyOffer('npub1nope', { fetchEvents: async () => [] });
    expect(expectRefusal(result)).toBe('bad_pointer');
  });
});
