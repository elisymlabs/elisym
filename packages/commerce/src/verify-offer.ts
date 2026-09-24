import type { Filter, NostrEvent } from 'nostr-tools';
import { canonicalPayoutAddress, parseCaip19 } from './caip';
import {
  KIND_DELETION,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_AUTH,
  KIND_STORE_PROFILE,
  MAX_FUTURE_SKEW_SECS,
  PAYOUT_COOLDOWN_SECS,
} from './constants';
import {
  type DomainKeys,
  type ResolveDomainOptions,
  resolveDomainKeys,
  splitNip05,
} from './domain';
import { type PayoutTarget, parsePayto } from './events/payto';
import {
  type Product,
  decodeProductNaddr,
  isPurchasable,
  parseProduct,
  productAddress,
} from './events/product';
import { readStoreAuth, storeAuthAddress } from './events/store-auth';
import { type StoreProfile, parseStoreProfile } from './events/store-profile';
import { expirationState, nowSecs, tagValue, tagValues } from './tags';
import { isEventShaped, isGenuineEvent } from './verify';

/**
 * A: the merchant's domain names both the store and the owner.
 * B: a hosted name (e.g. `shop@elisym.shop`) - trust in the name registrar.
 * C: keys only - the owner is pinned on first use.
 */
export type TrustLevel = 'A' | 'B' | 'C';

export type OfferRefusal =
  | 'bad_pointer'
  | 'product_missing'
  | 'product_not_on_sale'
  | 'store_profile_missing'
  | 'owner_unknown'
  | 'owner_mismatch'
  | 'owner_pin_mismatch'
  | 'domain_mismatch'
  | 'store_auth_missing'
  | 'store_auth_revoked'
  | 'store_auth_expired'
  | 'origin_mismatch'
  | 'payto_missing'
  | 'no_payout_for_accepted_assets';

export type OfferWarning =
  /** The profile names a domain that did not vouch for both keys; trust fell back to level C. */
  | 'domain_unverified'
  /** The page embedding the widget is not on the merchant's domain. */
  | 'origin_mismatch'
  /** No domain to compare the page with (levels B and C). */
  | 'origin_unverifiable'
  /** The newest payout event is younger than the cool-down: the owner key may be in new hands. */
  | 'payout_recently_changed'
  /** A payout address is not among the `knownPayouts` of earlier purchases. */
  | 'payout_changed'
  /** A payout address carries no wallet proof. */
  | 'payout_unsigned'
  /**
   * No `pinnedOwnerPubkey` (a first purchase): nothing but this bundle names the
   * owner, and a stolen store key can name a new one - at level A through a
   * domain of its own. Pin the owner after paying and pass it next time.
   */
  | 'owner_unpinned';

export interface VerifiedOffer {
  level: TrustLevel;
  /** Levels A and B: the domain that vouches for the store. */
  domain?: string;
  storePubkey: string;
  ownerPubkey: string;
  profile: StoreProfile;
  product: Product;
  /** Where a payment for this offer may go: the owner's 10133 addresses for the assets the product accepts. */
  payouts: PayoutTarget[];
  paytoCreatedAt: number;
  warnings: OfferWarning[];
}

export type OfferVerification =
  | { ok: true; offer: VerifiedOffer }
  | { ok: false; refusal: OfferRefusal; message: string };

/**
 * The signed events one offer rests on, as relays (or a resolver) handed them
 * over. Nothing here is trusted: every event is checked for its signature, its
 * author and its kind before it counts, and extras are ignored.
 */
export interface OfferBundle {
  events: readonly NostrEvent[];
  /**
   * What the store's `nip05` domain vouches for: keys, `'unreachable'` when it
   * answered nothing, or absent when the profile names no domain or it was not
   * looked up. The answer is unsigned: take it from the client's own lookup,
   * never from a resolver.
   */
  domain?: DomainKeys | 'unreachable';
}

export interface EvaluateOfferOptions {
  now?: number;
  /** The origin of the page embedding the checkout (from `postMessage`'s `event.origin`). */
  pageOrigin?: string;
  /** Refuse, rather than warn, when the page is not on the merchant's domain - or its origin is not given. */
  strictOrigin?: boolean;
  /** Domains that issue hosted names (level B), e.g. `['elisym.shop']`. */
  hostedDomains?: readonly string[];
  /** The owner pinned at the first purchase from this store (TOFU). A new owner then needs a re-pin. */
  pinnedOwnerPubkey?: string;
  cooldownSecs?: number;
  /**
   * When an index (resolver, relay) first saw the newest 10133. The cool-down
   * counts from the later of this and the event's own `created_at`, which the
   * signer picks and can back-date.
   */
  paytoFirstSeenAt?: number;
  /**
   * Payout addresses paid at earlier purchases from this store (TOFU). A payout
   * outside this set is flagged `payout_changed`, however old its event claims to be.
   * Leave it out on a first purchase: an empty list flags every address.
   */
  knownPayouts?: readonly { caip19: string; address: string }[];
}

function refuse(refusal: OfferRefusal, message: string): OfferVerification {
  return { ok: false, refusal, message };
}

/** The newest event of `kind` by `author` (and `d`, when given) that is genuinely signed. */
function newestSigned(
  events: readonly NostrEvent[],
  kind: number,
  author: string,
  now: number,
  d?: string,
): NostrEvent | undefined {
  let newest: NostrEvent | undefined;
  for (const event of events) {
    if (
      !isEventShaped(event) ||
      event.kind !== kind ||
      event.pubkey !== author ||
      event.created_at > now + MAX_FUTURE_SKEW_SECS ||
      (d !== undefined && tagValue(event.tags, 'd') !== d)
    ) {
      continue;
    }
    // Ties on created_at go to the lowest id (NIP-01), so every reader picks the same one.
    if (
      newest &&
      (event.created_at < newest.created_at ||
        (event.created_at === newest.created_at && event.id >= newest.id))
    ) {
      continue;
    }
    if (isGenuineEvent(event)) {
      newest = event;
    }
  }
  return newest;
}

/**
 * For evidence that can only refuse (revocations, deletions): no future-date
 * window, so a signer's fast clock cannot delay it.
 */
const NO_FUTURE_LIMIT = Number.POSITIVE_INFINITY;

/** The newest genuine NIP-09 deletion by `author` that names the addressable `address`. */
function newestDeletion(
  events: readonly NostrEvent[],
  address: string,
  author: string,
  now: number,
): NostrEvent | undefined {
  return newestSigned(
    events.filter((event) => isEventShaped(event) && tagValues(event.tags, 'a').includes(address)),
    KIND_DELETION,
    author,
    now,
  );
}

/** NIP-40: past its `expiration`, or with one that cannot be read. */
function isLapsed(event: NostrEvent, now: number): boolean {
  const state = expirationState(event.tags, now);
  return state === 'expired' || state === 'malformed';
}

function originMatchesDomain(pageOrigin: string, domain: string): boolean {
  let url: URL;
  try {
    url = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

interface Anchor {
  level: TrustLevel;
  domain?: string;
  ownerPubkey: string;
  /** The domain named the owner itself, so a missing AUTH is not a gap. */
  ownerFromDomain: boolean;
  warnings: OfferWarning[];
}

function resolveAnchor(
  storePubkey: string,
  profile: StoreProfile,
  bundle: OfferBundle,
  options: EvaluateOfferOptions,
): Anchor | OfferVerification {
  const warnings: OfferWarning[] = [];
  const nip05 = profile.nip05 === undefined ? undefined : splitNip05(profile.nip05);
  const hosted = nip05 !== undefined && (options.hostedDomains ?? []).includes(nip05.domain);
  const keys = typeof bundle.domain === 'object' ? bundle.domain : undefined;
  let hostedDomain: string | undefined;
  // The TXT record names the domain's own (`_`) store. Under another name a
  // different store there is no verdict on this one - the nostr.json that would
  // have named it just did not answer.
  const txtForAnotherName =
    nip05 !== undefined &&
    keys !== undefined &&
    keys.source === 'dns' &&
    nip05.local !== '_' &&
    keys.storePubkey !== storePubkey;

  // An answer that names no store at all is no verdict either (a custom resolver may return one).
  // The answer must be for this very name: one looked up for `alice@` says
  // nothing about a profile that now claims `_@` on the same domain.
  if (
    nip05 &&
    keys &&
    keys.domain === nip05.domain &&
    keys.name === nip05.local &&
    keys.storePubkey !== undefined &&
    !txtForAnotherName
  ) {
    // A domain that answers and names ANOTHER store is not a failed lookup: it
    // says this profile is not the store it claims to be.
    if (keys.storePubkey !== storePubkey) {
      return refuse('domain_mismatch', `${nip05.domain} does not name this store`);
    }
    // Only the domain's own entries speak for the domain: `_` in nostr.json, or
    // the `_elisym` TXT record. Under any other name (`alice@provider.com`) the
    // `owner` entry is whoever registered `owner@` on a shared host.
    const domainWide = nip05.local === '_' || keys.source === 'dns';
    // The store-signed profile must name the same owner: the domain answer is
    // unsigned, so on its own whoever relays it (a resolver) could pick the owner.
    if (!hosted && domainWide && keys.ownerPubkey && profile.ownerPubkey !== undefined) {
      if (profile.ownerPubkey !== keys.ownerPubkey) {
        return refuse('owner_mismatch', 'The store profile and its domain name different owners');
      }
      return {
        level: 'A',
        domain: nip05.domain,
        ownerPubkey: keys.ownerPubkey,
        ownerFromDomain: true,
        warnings,
      };
    }
    if (hosted) {
      hostedDomain = nip05.domain;
    } else {
      warnings.push('domain_unverified');
    }
  } else if (profile.nip05 !== undefined) {
    // Also a nip05 that is not a public name at all: it claimed a domain and has none.
    warnings.push('domain_unverified');
  }

  if (!profile.ownerPubkey) {
    return refuse('owner_unknown', 'The store profile names no owner');
  }
  if (hostedDomain !== undefined) {
    return {
      level: 'B',
      domain: hostedDomain,
      ownerPubkey: profile.ownerPubkey,
      ownerFromDomain: false,
      warnings,
    };
  }
  return { level: 'C', ownerPubkey: profile.ownerPubkey, ownerFromDomain: false, warnings };
}

/**
 * Verify an offer from its signed events (spec section 3, steps 2-7 and 9's
 * address set). Pure: no network, so the same code runs on relay results and
 * on a resolver bundle, and a test feeds it exactly what it needs.
 *
 * The protocol fee (step 8) is not read here: the payer reads it from chain with
 * `@elisym/pay-core` when it builds the payment.
 */
export function evaluateOffer(
  pointer: { storePubkey: string; d: string },
  bundle: OfferBundle,
  options: EvaluateOfferOptions = {},
): OfferVerification {
  const now = options.now ?? nowSecs();
  const { storePubkey } = pointer;

  const productEvent = newestSigned(bundle.events, KIND_PRODUCT, storePubkey, now, pointer.d);
  const product =
    productEvent && !isLapsed(productEvent, now) ? parseProduct(productEvent) : undefined;
  if (!product) {
    return refuse('product_missing', 'No valid, unexpired listing signed by the store');
  }
  // NIP-09: the store deleted the listing, and a relay that kept it does not bring it back.
  const productDeletion = newestDeletion(
    bundle.events,
    productAddress(product),
    storePubkey,
    NO_FUTURE_LIMIT,
  );
  if (productDeletion !== undefined && productDeletion.created_at >= product.createdAt) {
    return refuse('product_missing', 'The store deleted this listing');
  }
  if (!isPurchasable(product)) {
    return refuse('product_not_on_sale', `The listing is ${product.visibility}`);
  }

  const profileEvent = newestSigned(bundle.events, KIND_STORE_PROFILE, storePubkey, now);
  const profile =
    profileEvent && !isLapsed(profileEvent, now) ? parseStoreProfile(profileEvent) : undefined;
  if (!profile) {
    return refuse('store_profile_missing', 'No valid, unexpired profile signed by the store');
  }

  const anchor = resolveAnchor(storePubkey, profile, bundle, options);
  if ('ok' in anchor) {
    return anchor;
  }
  const { ownerPubkey } = anchor;
  const warnings = [...anchor.warnings];
  // At every level: a stolen store key can point the profile at a new owner, and
  // at a domain of the thief's own that names that owner too.
  if (options.pinnedOwnerPubkey !== undefined && options.pinnedOwnerPubkey !== ownerPubkey) {
    return refuse(
      'owner_pin_mismatch',
      'The store now names a different owner than at the first purchase',
    );
  }
  // Level A included: a stolen store key can point the profile at a domain of
  // the thief's own, so a first purchase is on trust at every level.
  if (options.pinnedOwnerPubkey === undefined) {
    warnings.push('owner_unpinned');
  }

  // The owner's newest word on this store wins. Level A does not NEED an AUTH -
  // the domain already links the two - but a revocation still stands.
  const authEvent = newestSigned(bundle.events, KIND_STORE_AUTH, ownerPubkey, now, storePubkey);
  const auth = authEvent ? readStoreAuth(authEvent, storePubkey, now) : undefined;
  // NIP-09: a deletion that names the AUTH address removes every version up to its own date.
  const deletion = newestDeletion(
    bundle.events,
    storeAuthAddress(ownerPubkey, storePubkey),
    ownerPubkey,
    NO_FUTURE_LIMIT,
  );
  // A revocation dated past the skew window (a fast clock) still revokes: the
  // window stops an event from pinning itself as newest, and this can only refuse.
  const revocation = newestSigned(
    bundle.events.filter(
      (event) =>
        isEventShaped(event) && readStoreAuth(event, storePubkey, now).status === 'revoked',
    ),
    KIND_STORE_AUTH,
    ownerPubkey,
    NO_FUTURE_LIMIT,
    storePubkey,
  );
  const revokedAfter = (event: NostrEvent | undefined): boolean =>
    event !== undefined && (!authEvent || event.created_at >= authEvent.created_at);
  if (auth?.status === 'revoked' || revokedAfter(deletion) || revokedAfter(revocation)) {
    return refuse('store_auth_revoked', 'The owner revoked this store key');
  }
  if (auth?.status === 'expired') {
    return refuse('store_auth_expired', "The owner's authorization of this store key expired");
  }
  // The owner's newest word on this store cannot be read: fail closed at every
  // level, as it may be a revocation or an expiry written some other way.
  if (auth?.status === 'malformed') {
    return refuse(
      'store_auth_missing',
      "The owner's newest authorization of this store key is malformed",
    );
  }
  if (!anchor.ownerFromDomain && auth?.status !== 'active') {
    return refuse('store_auth_missing', 'The owner has not authorized this store key');
  }

  if (options.strictOrigin && options.pageOrigin === undefined) {
    return refuse('origin_mismatch', 'Strict mode needs the origin of the embedding page');
  }
  if (options.pageOrigin !== undefined) {
    if (anchor.level !== 'A' || anchor.domain === undefined) {
      // Strict mode must not be escaped by dropping the domain from the profile.
      if (options.strictOrigin) {
        return refuse('origin_mismatch', 'The store has no verified domain to match this page');
      }
      warnings.push('origin_unverifiable');
    } else if (!originMatchesDomain(options.pageOrigin, anchor.domain)) {
      if (options.strictOrigin) {
        return refuse('origin_mismatch', `This page is not on ${anchor.domain}`);
      }
      warnings.push('origin_mismatch');
    }
  }

  const paytoEvent = newestSigned(bundle.events, KIND_PAYTO, ownerPubkey, now);
  // An expired 10133 still served by a relay that ignores NIP-40 names wallets
  // the owner has stopped vouching for: nothing replaces it, so nothing is paid.
  if (!paytoEvent || isLapsed(paytoEvent, now)) {
    return refuse('payto_missing', 'The owner has no current payout addresses');
  }
  const accepted = new Set(product.accept);
  const payouts = parsePayto(paytoEvent).targets.filter((target) => accepted.has(target.caip19.id));
  if (payouts.length === 0) {
    return refuse(
      'no_payout_for_accepted_assets',
      'The owner has no payout address for any asset this product accepts',
    );
  }
  // `created_at` is whatever the signer wrote, so a thief with the owner key can
  // back-date a new 10133 past the cool-down. A first-seen time from an index,
  // and the addresses paid before, are what the signer cannot choose.
  const paytoAge = now - Math.max(paytoEvent.created_at, options.paytoFirstSeenAt ?? 0);
  if (paytoAge < (options.cooldownSecs ?? PAYOUT_COOLDOWN_SECS)) {
    warnings.push('payout_recently_changed');
  }
  const knownPayouts = options.knownPayouts;
  if (
    knownPayouts !== undefined &&
    payouts.some(
      (target) =>
        !knownPayouts.some(
          (known) =>
            known.caip19 === target.caip19.id &&
            canonicalPayoutAddress(target.caip19.chain, known.address) === target.address,
        ),
    )
  ) {
    warnings.push('payout_changed');
  }
  if (payouts.some((target) => !target.walletSigned)) {
    warnings.push('payout_unsigned');
  }

  const offer: VerifiedOffer = {
    level: anchor.level,
    storePubkey,
    ownerPubkey,
    profile,
    product,
    payouts,
    paytoCreatedAt: paytoEvent.created_at,
    warnings,
  };
  if (anchor.domain !== undefined) {
    offer.domain = anchor.domain;
  }
  return { ok: true, offer };
}

/**
 * Step 9: whether a recipient named by ANY other source - a payment request, an
 * x402 `payTo`, an MPP challenge - is one of the owner's payout addresses for
 * that asset. Anything else must not be paid.
 */
export function isOfferPayout(offer: VerifiedOffer, caip19: string, recipient: string): boolean {
  const asset = parseCaip19(caip19);
  if (!asset) {
    return false;
  }
  const canonical = canonicalPayoutAddress(asset.chain, recipient);
  return (
    canonical !== undefined &&
    offer.payouts.some((target) => target.caip19.id === caip19 && target.address === canonical)
  );
}

export interface VerifyOfferDeps extends ResolveDomainOptions {
  /**
   * Query relays (or a resolver). The spec asks for at least two relays so one
   * cannot hide the newest payout event; that is this function's job, and its
   * results are all checked again here.
   */
  fetchEvents: (filters: Filter[]) => Promise<NostrEvent[]>;
  /**
   * Replace the domain lookup. It must be the client's OWN nostr.json / DoH
   * lookup: the answer is unsigned, so a resolver's copy is not evidence.
   */
  resolveDomain?: (nip05: string) => Promise<DomainKeys | undefined>;
}

/** A lookup that throws answered nothing, like one that returned nothing. */
async function resolveOrUnreachable(
  resolve: (nip05: string) => Promise<DomainKeys | undefined>,
  nip05: string,
): Promise<DomainKeys | undefined> {
  try {
    return await resolve(nip05);
  } catch {
    return undefined;
  }
}

/** Collect an offer's events from relays and verify it (spec section 3). */
export async function verifyOffer(
  naddr: string,
  deps: VerifyOfferDeps,
  options: EvaluateOfferOptions = {},
): Promise<OfferVerification> {
  const pointer = decodeProductNaddr(naddr);
  if (!pointer) {
    return refuse('bad_pointer', 'Not a product naddr');
  }
  const { storePubkey, d } = pointer;
  const storeEvents = await deps.fetchEvents([
    { kinds: [KIND_PRODUCT], authors: [storePubkey], '#d': [d] },
    { kinds: [KIND_STORE_PROFILE], authors: [storePubkey] },
    { kinds: [KIND_DELETION], authors: [storePubkey], '#a': [productAddress({ storePubkey, d })] },
  ]);
  const now = options.now ?? nowSecs();
  const profileEvent = newestSigned(storeEvents, KIND_STORE_PROFILE, storePubkey, now);
  const profile = profileEvent ? parseStoreProfile(profileEvent) : undefined;

  let domain: OfferBundle['domain'];
  if (profile?.nip05 !== undefined) {
    // The name is store-controlled: a custom resolver never sees one that is
    // not a public host (loopback, a private IP), as the default lookup never fetches it.
    const resolve = deps.resolveDomain ?? ((nip05: string) => resolveDomainKeys(nip05, deps));
    domain =
      splitNip05(profile.nip05) === undefined
        ? 'unreachable'
        : ((await resolveOrUnreachable(resolve, profile.nip05)) ?? 'unreachable');
  }

  const owners = new Set<string>();
  if (profile?.ownerPubkey) {
    owners.add(profile.ownerPubkey);
  }
  if (typeof domain === 'object' && domain.ownerPubkey) {
    owners.add(domain.ownerPubkey);
  }
  const ownerEvents =
    owners.size === 0
      ? []
      : await deps.fetchEvents([
          { kinds: [KIND_PAYTO], authors: [...owners] },
          { kinds: [KIND_STORE_AUTH], authors: [...owners], '#d': [storePubkey] },
          {
            kinds: [KIND_DELETION],
            authors: [...owners],
            '#a': [...owners].map((owner) => storeAuthAddress(owner, storePubkey)),
          },
        ]);

  // The owner query brings the owner's word only: a store event that rides
  // along could swap in another profile than the one whose domain was looked up.
  const ownerKinds: readonly number[] = [KIND_PAYTO, KIND_STORE_AUTH, KIND_DELETION];
  const ownerOnly = ownerEvents.filter(
    (event) => isEventShaped(event) && owners.has(event.pubkey) && ownerKinds.includes(event.kind),
  );
  const bundle: OfferBundle = { events: [...storeEvents, ...ownerOnly] };
  if (domain !== undefined) {
    bundle.domain = domain;
  }
  // One clock for both passes: the profile picked here is the one judged there.
  return evaluateOffer({ storePubkey, d }, bundle, { ...options, now });
}
