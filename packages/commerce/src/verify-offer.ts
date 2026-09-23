import type { Filter, NostrEvent } from 'nostr-tools';
import { canonicalPayoutAddress, parseCaip19 } from './caip';
import {
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
import { type Product, decodeProductNaddr, isPurchasable, parseProduct } from './events/product';
import { readStoreAuth } from './events/store-auth';
import { type StoreProfile, parseStoreProfile } from './events/store-profile';
import { nowSecs, tagValue } from './tags';
import { isGenuineEvent } from './verify';

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
  /** The profile names a domain that did not answer; trust fell back to level C. */
  | 'domain_unverified'
  /** The page embedding the widget is not on the merchant's domain. */
  | 'origin_mismatch'
  /** No domain to compare the page with (levels B and C). */
  | 'origin_unverifiable'
  /** The newest payout event is younger than the cool-down: the owner key may be in new hands. */
  | 'payout_recently_changed'
  /** A payout address carries no wallet proof. */
  | 'payout_unsigned';

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
   * looked up.
   */
  domain?: DomainKeys | 'unreachable';
}

export interface EvaluateOfferOptions {
  now?: number;
  /** The origin of the page embedding the checkout (from `postMessage`'s `event.origin`). */
  pageOrigin?: string;
  /** Refuse, rather than warn, when the page is not on the merchant's domain. */
  strictOrigin?: boolean;
  /** Domains that issue hosted names (level B), e.g. `['elisym.shop']`. */
  hostedDomains?: readonly string[];
  /** Level C: the owner pinned at the first purchase from this store. */
  pinnedOwnerPubkey?: string;
  cooldownSecs?: number;
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

  if (nip05 && keys && keys.domain === nip05.domain) {
    // A domain that answers and names ANOTHER store is not a failed lookup: it
    // says this profile is not the store it claims to be.
    if (keys.storePubkey !== storePubkey) {
      return refuse('domain_mismatch', `${nip05.domain} does not name this store`);
    }
    if (!hosted && keys.ownerPubkey) {
      if (profile.ownerPubkey !== undefined && profile.ownerPubkey !== keys.ownerPubkey) {
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
    if (hosted && profile.ownerPubkey) {
      return {
        level: 'B',
        domain: nip05.domain,
        ownerPubkey: profile.ownerPubkey,
        ownerFromDomain: false,
        warnings,
      };
    }
  } else if (nip05 && !hosted) {
    warnings.push('domain_unverified');
  }

  if (!profile.ownerPubkey) {
    return refuse('owner_unknown', 'Nothing names the owner of this store');
  }
  if (
    options.pinnedOwnerPubkey !== undefined &&
    options.pinnedOwnerPubkey !== profile.ownerPubkey
  ) {
    return refuse(
      'owner_pin_mismatch',
      'The store now names a different owner than at the first purchase',
    );
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
  const product = productEvent ? parseProduct(productEvent) : undefined;
  if (!product) {
    return refuse('product_missing', 'No valid listing signed by the store');
  }
  if (!isPurchasable(product)) {
    return refuse('product_not_on_sale', `The listing is ${product.visibility}`);
  }

  const profileEvent = newestSigned(bundle.events, KIND_STORE_PROFILE, storePubkey, now);
  const profile = profileEvent ? parseStoreProfile(profileEvent) : undefined;
  if (!profile) {
    return refuse('store_profile_missing', 'No valid profile signed by the store');
  }

  const anchor = resolveAnchor(storePubkey, profile, bundle, options);
  if ('ok' in anchor) {
    return anchor;
  }
  const { ownerPubkey } = anchor;
  const warnings = [...anchor.warnings];

  // The owner's newest word on this store wins. Level A does not NEED an AUTH -
  // the domain already links the two - but a revocation still stands.
  const authEvent = newestSigned(bundle.events, KIND_STORE_AUTH, ownerPubkey, now, storePubkey);
  const auth = authEvent ? readStoreAuth(authEvent, storePubkey, now) : undefined;
  if (auth?.status === 'revoked') {
    return refuse('store_auth_revoked', 'The owner revoked this store key');
  }
  if (auth?.status === 'expired') {
    return refuse('store_auth_expired', "The owner's authorization of this store key expired");
  }
  if (!anchor.ownerFromDomain && auth?.status !== 'active') {
    return refuse('store_auth_missing', 'The owner has not authorized this store key');
  }

  if (options.pageOrigin !== undefined) {
    if (anchor.level !== 'A' || anchor.domain === undefined) {
      warnings.push('origin_unverifiable');
    } else if (!originMatchesDomain(options.pageOrigin, anchor.domain)) {
      if (options.strictOrigin) {
        return refuse('origin_mismatch', `This page is not on ${anchor.domain}`);
      }
      warnings.push('origin_mismatch');
    }
  }

  const paytoEvent = newestSigned(bundle.events, KIND_PAYTO, ownerPubkey, now);
  if (!paytoEvent) {
    return refuse('payto_missing', 'The owner has published no payout addresses');
  }
  const accepted = new Set(product.accept);
  const payouts = parsePayto(paytoEvent).targets.filter((target) => accepted.has(target.caip19.id));
  if (payouts.length === 0) {
    return refuse(
      'no_payout_for_accepted_assets',
      'The owner has no payout address for any asset this product accepts',
    );
  }
  if (now - paytoEvent.created_at < (options.cooldownSecs ?? PAYOUT_COOLDOWN_SECS)) {
    warnings.push('payout_recently_changed');
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
  /** Replace the domain lookup (a resolver bundle already carries it). */
  resolveDomain?: (nip05: string) => Promise<DomainKeys | undefined>;
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
  ]);
  const now = options.now ?? nowSecs();
  const profileEvent = newestSigned(storeEvents, KIND_STORE_PROFILE, storePubkey, now);
  const profile = profileEvent ? parseStoreProfile(profileEvent) : undefined;

  let domain: OfferBundle['domain'];
  if (profile?.nip05 !== undefined) {
    const resolve = deps.resolveDomain ?? ((nip05: string) => resolveDomainKeys(nip05, deps));
    domain = (await resolve(profile.nip05)) ?? 'unreachable';
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
        ]);

  const bundle: OfferBundle = { events: [...storeEvents, ...ownerEvents] };
  if (domain !== undefined) {
    bundle.domain = domain;
  }
  return evaluateOffer({ storePubkey, d }, bundle, options);
}
