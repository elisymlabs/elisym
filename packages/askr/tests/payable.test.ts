import {
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  buildProductEvent,
} from '@elisym/commerce';
import { decodeProductNaddr } from '@elisym/commerce';
import { CHAINS } from '@elisym/pay-core';
import type { EventTemplate } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogAuth,
  readCatalogAuthority,
  readPayableKeys,
} from '../src/events/catalog-auth';
import { parseCatalogItem } from '../src/events/catalog-item';
import { ASKR_RELAYS, KIND_CATALOG_AUTH, PAYABLE_CHAIN_NETWORKS } from '../src/index';
import { NOW, sign, testKey } from './fixtures';

const owner = testKey();
const store = testKey();
const other = testKey();

const DEVNET_USDC =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAINNET_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function listing(accept: string[], d = 'course'): EventTemplate {
  return buildProductEvent({
    d,
    title: 'Course',
    description: 'A course.',
    price: { amount: '25', currency: 'USD' },
    accept,
    createdAt: NOW - 10,
  });
}

function storeAuth(createdAt = NOW - 100, expiresAt?: number) {
  return sign(
    buildStoreAuthEvent({
      storePubkey: store.pubkey,
      mode: 'hosted',
      operator: 'elisym.network',
      createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
    owner,
  );
}

describe('PayCore listings in an Askr catalog', () => {
  const devnetListing = sign(listing([DEVNET_USDC]), store);

  it('keeps a listing with accept tags by the configured catalog key, without payable when no 30490 is active', () => {
    const item = parseCatalogItem(devnetListing, { now: NOW, catalogKey: store.pubkey });
    expect(item?.title).toBe('Course');
    expect(item?.payable).toBeUndefined();
    const empty = parseCatalogItem(devnetListing, {
      now: NOW,
      catalogKey: store.pubkey,
      payableKeys: new Set(),
    });
    expect(empty).toBeDefined();
    expect(empty?.payable).toBeUndefined();
  });

  it('drops a listing with accept tags by any other author, and without a catalog key', () => {
    expect(parseCatalogItem(devnetListing, { now: NOW, catalogKey: other.pubkey })).toBeUndefined();
    expect(parseCatalogItem(devnetListing, { now: NOW })).toBeUndefined();
    // payableKeys alone never admits a listing.
    expect(
      parseCatalogItem(devnetListing, { now: NOW, payableKeys: new Set([store.pubkey]) }),
    ).toBeUndefined();
  });

  it('marks it payable with its naddr and network when its author is a payable key', () => {
    const item = parseCatalogItem(devnetListing, {
      now: NOW,
      catalogKey: store.pubkey,
      payableKeys: new Set([store.pubkey]),
    });
    expect(item?.payable?.network).toBe('devnet');
    const pointer = decodeProductNaddr(item?.payable?.naddr ?? '');
    expect(pointer).toEqual({ storePubkey: store.pubkey, d: 'course', relays: [...ASKR_RELAYS] });
    const mainnet = parseCatalogItem(sign(listing([MAINNET_USDC]), store), {
      now: NOW,
      catalogKey: store.pubkey,
      payableKeys: new Set([store.pubkey]),
    });
    expect(mainnet?.payable?.network).toBe('mainnet');
  });

  it('a listing without accept is never payable', () => {
    const plain = sign(
      {
        kind: 30402,
        created_at: NOW - 10,
        content: '',
        tags: [...listing([DEVNET_USDC]).tags].filter((tag) => tag[0] !== 'accept'),
      },
      store,
    );
    const item = parseCatalogItem(plain, {
      now: NOW,
      catalogKey: store.pubkey,
      payableKeys: new Set([store.pubkey]),
    });
    expect(item).toBeDefined();
    expect(item?.payable).toBeUndefined();
  });

  it('mixed networks or an unknown chain leave the listing shown but not payable', () => {
    const options = { now: NOW, catalogKey: store.pubkey, payableKeys: new Set([store.pubkey]) };
    const mixed = parseCatalogItem(sign(listing([DEVNET_USDC, MAINNET_USDC]), store), options);
    expect(mixed).toBeDefined();
    expect(mixed?.payable).toBeUndefined();
    const template = listing([DEVNET_USDC]);
    const unknown = sign(
      {
        ...template,
        tags: [...template.tags, ['accept', 'cosmos:cosmoshub-4/token:uatom']],
      },
      store,
    );
    const read = parseCatalogItem(unknown, options);
    expect(read).toBeDefined();
    expect(read?.payable).toBeUndefined();
  });
});

describe('readPayableKeys', () => {
  it('returns a key the owner authorizes in an active 30490, in either mode', () => {
    expect(readPayableKeys([storeAuth()], owner.pubkey, NOW)).toEqual(new Set([store.pubkey]));
    const selfHost = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: NOW - 100 }),
      owner,
    );
    expect(readPayableKeys([selfHost], owner.pubkey, NOW)).toEqual(new Set([store.pubkey]));
  });

  it('drops a revoked, expired, deleted or foreign authorization', () => {
    const revoked = sign(buildStoreRevocationEvent(store.pubkey, NOW - 50), owner);
    expect(readPayableKeys([storeAuth(), revoked], owner.pubkey, NOW).size).toBe(0);
    expect(readPayableKeys([storeAuth(NOW - 100, NOW - 1)], owner.pubkey, NOW).size).toBe(0);
    const deletion = sign(
      {
        kind: 5,
        created_at: NOW - 50,
        content: '',
        tags: [['a', `30490:${owner.pubkey}:${store.pubkey}`]],
      },
      owner,
    );
    expect(readPayableKeys([storeAuth(), deletion], owner.pubkey, NOW).size).toBe(0);
    // Signed by someone other than the owner.
    const foreign = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'hosted', createdAt: NOW - 100 }),
      other,
    );
    expect(readPayableKeys([foreign], owner.pubkey, NOW).size).toBe(0);
  });

  it('a re-authorization after a deletion counts again', () => {
    const deletion = sign(
      {
        kind: 5,
        created_at: NOW - 50,
        content: '',
        tags: [['a', `30490:${owner.pubkey}:${store.pubkey}`]],
      },
      owner,
    );
    expect(readPayableKeys([deletion, storeAuth(NOW - 10)], owner.pubkey, NOW)).toEqual(
      new Set([store.pubkey]),
    );
  });

  it('a 30497 catalog authorization is not a store authorization, and the reverse', () => {
    const catalogAuth = sign(
      buildCatalogAuth({ key: store.pubkey, mode: 'self-host', createdAt: NOW - 100 }),
      owner,
    );
    expect(readPayableKeys([catalogAuth], owner.pubkey, NOW).size).toBe(0);
    expect(readCatalogAuthority([storeAuth()], owner.pubkey, NOW).size).toBe(0);
    expect(readCatalogAuthority([catalogAuth], owner.pubkey, NOW)).toEqual(new Set([store.pubkey]));
  });
});

describe('buildCatalogAuth operator', () => {
  it('writes the operator beside a hosted mode, and nothing without one', () => {
    const hosted = buildCatalogAuth({
      key: store.pubkey,
      mode: 'hosted',
      operator: 'elisym.network',
    });
    expect(hosted.kind).toBe(KIND_CATALOG_AUTH);
    expect(hosted.tags).toContainEqual(['mode', 'hosted', 'elisym.network']);
    const plain = buildCatalogAuth({ key: store.pubkey, mode: 'self-host' });
    expect(plain.tags).toContainEqual(['mode', 'self-host']);
  });
});

describe('PAYABLE_CHAIN_NETWORKS', () => {
  it('equals the payment registry chain table', () => {
    const registry = Object.fromEntries(
      Object.values(CHAINS).map((chain) => [chain.caip2, chain.network]),
    );
    expect(PAYABLE_CHAIN_NETWORKS).toEqual(registry);
  });
});
