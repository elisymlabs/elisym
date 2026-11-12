import { buildProductEvent } from '@elisym/commerce';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ComparisonComponentSchema, newAskId } from '../src/chat/messages';
import { unwrapChatMessage, wrapChatMessage } from '../src/chat/wrap';
import { LIMITS } from '../src/constants';
import { buildCatalogAuth } from '../src/events/catalog-auth';
import { buildCatalogItemEvent, parseCatalogItem } from '../src/events/catalog-item';
import { buildConfigEvent, decryptPrivateConfig, parseConfig } from '../src/events/config';
import { syncCatalog } from '../src/sync';
import { buildTicket, checkTicket } from '../src/ticket';
import { craftWrap } from './craft';
import { MemoryRelay, NOW, sign, testKey } from './fixtures';

const visitor = testKey();
const assistant = testKey();

function statusContent(): string {
  return JSON.stringify({ type: 'status', ask_id: newAskId(), text: 'searching' });
}

function craft(overrides: Partial<Parameters<typeof craftWrap>[0]> = {}) {
  return craftWrap({
    content: statusContent(),
    sender: visitor.secretKey,
    recipient: assistant.pubkey,
    now: NOW,
    ...overrides,
  });
}

describe('unwrapChatMessage refuses each forgery', () => {
  it('accepts the well-formed control case', () => {
    expect(unwrapChatMessage(craft(), assistant.secretKey)?.senderPubkey).toBe(visitor.pubkey);
  });

  it('a rumor claiming someone other than the seal signer', () => {
    expect(
      unwrapChatMessage(craft({ rumorPubkey: testKey().pubkey }), assistant.secretKey),
    ).toBeUndefined();
  });

  it('a rumor whose id is not its hash', () => {
    expect(
      unwrapChatMessage(craft({ rumorId: 'f'.repeat(64) }), assistant.secretKey),
    ).toBeUndefined();
  });

  it('a signed rumor', () => {
    expect(
      unwrapChatMessage(craft({ rumorSig: 'a'.repeat(128) }), assistant.secretKey),
    ).toBeUndefined();
  });

  it('a seal with tags', () => {
    expect(
      unwrapChatMessage(craft({ sealTags: [['p', assistant.pubkey]] }), assistant.secretKey),
    ).toBeUndefined();
  });

  it('a seal with a bad signature', () => {
    expect(unwrapChatMessage(craft({ breakSealSig: true }), assistant.secretKey)).toBeUndefined();
  });

  it('a wrap with a bad signature but valid encryption', () => {
    expect(unwrapChatMessage(craft({ breakWrapSig: true }), assistant.secretKey)).toBeUndefined();
  });

  it('a rumor naming another recipient than the wrap', () => {
    expect(
      unwrapChatMessage(craft({ rumorRecipient: testKey().pubkey }), assistant.secretKey),
    ).toBeUndefined();
  });

  it('the rumor ceiling is the largest size NIP-44 can still seal', () => {
    // At the ceiling the double wrap fits; one byte over pads to 49 152 and the
    // seal no longer fits NIP-44's 65 535-byte plaintext, so the receivers'
    // ceiling check is defense in depth that no genuine wrap can reach.
    expect(() => craft({ padRumorTo: LIMITS.RUMOR_CEILING_BYTES - 400 })).not.toThrow();
    expect(() => craft({ padRumorTo: LIMITS.RUMOR_CEILING_BYTES + 100 })).toThrow(/plaintext size/);
  });

  it('a well-formed ciphertext over the wrap bound, refused before decrypting', () => {
    const ephemeral = generateSecretKey();
    const big = nip44.v2.encrypt(
      'x'.repeat(60_000),
      nip44.v2.utils.getConversationKey(ephemeral, assistant.pubkey),
    );
    expect(big.length).toBeGreaterThan(LIMITS.WRAP_CONTENT_MAX_CHARS);
    const wrap = finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [['p', assistant.pubkey]], content: big },
      ephemeral,
    );
    expect(unwrapChatMessage(wrap, assistant.secretKey)).toBeUndefined();
  });

  it('refuses to build with a fractional clock', () => {
    expect(() =>
      wrapChatMessage({
        message: JSON.parse(statusContent()),
        senderSecretKey: visitor.secretKey,
        recipientPubkey: assistant.pubkey,
        expiresAt: NOW + 60,
        now: NOW + 0.5,
      }),
    ).toThrow(/whole seconds/);
  });
});

describe('checkTicket refuses each forgery', () => {
  const gateway = testKey();
  const store = testKey();
  const options = {
    gatewayKeys: [gateway.pubkey],
    store: store.pubkey,
    sender: visitor.pubkey,
    now: NOW,
  };
  const template = buildTicket({ visitor: visitor.pubkey, store: store.pubkey, now: NOW });

  it('a ticket claiming the gateway key with a bad signature', () => {
    const good = sign(template, gateway);
    const last = good.sig.slice(-1) === '0' ? '1' : '0';
    expect(checkTicket({ ...good, sig: good.sig.slice(0, -1) + last }, options)).toBe('invalid');
  });

  it('another kind', () => {
    expect(checkTicket(sign({ ...template, kind: 1 }, gateway), options)).toBe('invalid');
  });

  it('duplicated p, store or expiration tags', () => {
    for (const extra of [
      ['p', testKey().pubkey],
      ['store', testKey().pubkey],
      ['expiration', String(NOW + 10)],
    ]) {
      expect(
        checkTicket(sign({ ...template, tags: [...template.tags, extra] }, gateway), options),
      ).toBe('invalid');
    }
  });
});

describe('catalog item rules', () => {
  const key = testKey();

  it('drops a catalog-key listing with payment tags, keeps it for a Pay Core key', () => {
    const payCoreListing = sign(
      buildProductEvent({
        d: 'p1',
        title: 'P',
        description: '',
        price: { amount: '5', currency: 'USD' },
        accept: [
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        ],
        createdAt: NOW - 1,
      }),
      key,
    );
    expect(parseCatalogItem(payCoreListing, { now: NOW, role: 'catalog' })).toBeUndefined();
    expect(parseCatalogItem(payCoreListing, { now: NOW, role: 'paycore' })?.hasAccept).toBe(true);
  });

  const base = { d: 'x', title: 'X', options: [{ name: 'size', values: ['S', 'M'] }] };

  it('requires the price to be the lowest available variant price', () => {
    expect(() =>
      buildCatalogItemEvent({
        ...base,
        price: { amount: '10', currency: 'USD' },
        variants: [
          { id: 'a', price: '12', available: true, values: ['S'] },
          { id: 'b', price: '8', available: false, values: ['M'] },
        ],
      }),
    ).toThrow(/lowest/);
    expect(() =>
      buildCatalogItemEvent({
        ...base,
        price: { amount: '12.0', currency: 'USD' },
        variants: [
          { id: 'a', price: '12', available: true, values: ['S'] },
          { id: 'b', price: '8', available: false, values: ['M'] },
        ],
      }),
    ).not.toThrow();
  });

  it('requires sold-out when no variant is available', () => {
    const variants = [{ id: 'a', price: '12', available: false, values: ['S'] }];
    expect(() =>
      buildCatalogItemEvent({ ...base, price: { amount: '12', currency: 'USD' }, variants }),
    ).toThrow(/sold-out/);
    expect(() =>
      buildCatalogItemEvent({
        ...base,
        price: { amount: '12', currency: 'USD' },
        variants,
        visibility: 'sold-out',
      }),
    ).not.toThrow();
  });

  it('refuses duplicate variant ids and option names', () => {
    expect(() =>
      buildCatalogItemEvent({
        ...base,
        price: { amount: '1', currency: 'USD' },
        variants: [
          { id: 'a', price: '1', available: true, values: ['S'] },
          { id: 'a', price: '1', available: true, values: ['M'] },
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      buildCatalogItemEvent({
        d: 'x',
        title: 'X',
        price: { amount: '1', currency: 'USD' },
        options: [
          { name: 'size', values: ['S'] },
          { name: 'size', values: ['M'] },
        ],
      }),
    ).toThrow(/unique/);
  });

  it('requires one comparison cell per product', () => {
    const address = `30402:${key.pubkey}:a`;
    const other = `30402:${key.pubkey}:b`;
    expect(
      ComparisonComponentSchema.safeParse({
        type: 'comparison',
        addresses: [address, other],
        rows: [{ dimension: 'price', cells: ['1'] }],
      }).success,
    ).toBe(false);
  });
});

describe('config sizing', () => {
  const owner = testKey();
  const catalog = testKey();
  const baseConfig = {
    assistant: assistant.pubkey,
    origins: ['https://shop.example.com'],
    name: 'Shop',
    language: 'ru',
    currency: 'RUB',
    source: { kind: 'catalog' as const },
    catalogKey: catalog.pubkey,
  };

  it('reads back a private part at the byte cap in multibyte text', () => {
    // Cyrillic is two UTF-8 bytes per char: fill close to the 16 KiB byte cap.
    const event = sign(
      buildConfigEvent(
        { ...baseConfig, private: { voice: 'ж'.repeat(4_000), instructions: 'щ'.repeat(4_150) } },
        owner.secretKey,
      ),
      owner,
    );
    const parsed = parseConfig(event);
    expect(parsed).toBeDefined();
    expect(parsed && decryptPrivateConfig(parsed, assistant.secretKey)?.voice.length).toBe(4_000);
  });

  it('refuses a private part over the byte cap in the builder', () => {
    expect(() =>
      buildConfigEvent(
        {
          ...baseConfig,
          private: { voice: 'ж'.repeat(4_000), instructions: 'щ'.repeat(8_000) },
        },
        owner.secretKey,
      ),
    ).toThrow(/too large/);
  });

  it('requires an explicit policy key for a paycore source', () => {
    expect(() =>
      buildConfigEvent({ ...baseConfig, source: { kind: 'paycore' } }, owner.secretKey),
    ).toThrow(/policyKey/);
  });
});

describe('syncCatalog resilience', () => {
  const owner = testKey();
  const catalog = testKey();
  const item = (d: string) => ({ d, title: d, price: { amount: '1', currency: 'USD' } });

  function relay(): MemoryRelay {
    const memory = new MemoryRelay();
    memory.events.push(
      sign(buildCatalogAuth({ key: catalog.pubkey, mode: 'hosted', createdAt: NOW - 100 }), owner),
    );
    return memory;
  }

  it('retries a failed publish', async () => {
    const memory = relay();
    let failures = 1;
    const flaky = {
      query: memory.query.bind(memory),
      publish: async (relays: readonly string[], event: Parameters<MemoryRelay['publish']>[1]) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('relay busy');
        }
        await memory.publish(relays, event);
      },
    };
    const waits: number[] = [];
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: flaky,
      now: NOW,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(memory.published).toHaveLength(1);
    expect(waits).toEqual([1_000]);
  });

  it('retries the deletion when only the hidden version made it', async () => {
    const memory = relay();
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: memory,
      now: NOW,
      sleep: async () => {},
    });
    // Simulate a run that published the hidden version and then failed.
    const listed = memory.published[0];
    if (!listed) {
      throw new Error('expected a listing');
    }
    memory.events.push(
      sign(
        {
          kind: 30402,
          created_at: NOW + 5,
          tags: listed.tags
            .filter((tag) => tag[0] !== 'visibility')
            .concat([['visibility', 'hidden']]),
          content: listed.content,
        },
        catalog,
      ),
    );
    const before = memory.published.length;
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [],
      client: memory,
      now: NOW + 10,
      sleep: async () => {},
    });
    expect(diff.hidden).toEqual(['a']);
    expect(memory.published.slice(before).map((event) => event.kind)).toEqual([5]);
  });

  it('republishes a deleted item after the deletion', async () => {
    const memory = relay();
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: memory,
      now: NOW,
      sleep: async () => {},
    });
    await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [],
      client: memory,
      now: NOW + 10,
      sleep: async () => {},
    });
    const before = memory.published.length;
    const diff = await syncCatalog({
      signer: catalog.secretKey,
      store: owner.pubkey,
      items: [item('a')],
      client: memory,
      now: NOW + 10,
      sleep: async () => {},
    });
    expect(diff.created).toEqual(['a']);
    const republished = memory.published[before];
    expect(republished?.created_at).toBe(NOW + 11);
  });
});

describe('wrap backdating (2.4)', () => {
  it('wraps to an assistant key stay within ASSISTANT_WRAP_BACKDATE_SECS', async () => {
    const { ASSISTANT_WRAP_BACKDATE_SECS, wrapChatMessage } = await import('../src');
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const now = 1_800_000_000;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { wrap } = wrapChatMessage({
        message: { type: 'status', ask_id: 'a'.repeat(32), text: 'x' },
        senderSecretKey: generateSecretKey(),
        recipientPubkey: getPublicKey(generateSecretKey()),
        expiresAt: now + 60,
        now,
        maxBackdateSecs: ASSISTANT_WRAP_BACKDATE_SECS,
      });
      expect(wrap.created_at).toBeLessThanOrEqual(now);
      expect(wrap.created_at).toBeGreaterThanOrEqual(now - ASSISTANT_WRAP_BACKDATE_SECS);
    }
  });

  it('refuses a negative or fractional backdate', async () => {
    const { wrapChatMessage } = await import('../src');
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const base = {
      message: { type: 'status' as const, ask_id: 'a'.repeat(32), text: 'x' },
      senderSecretKey: generateSecretKey(),
      recipientPubkey: getPublicKey(generateSecretKey()),
      expiresAt: 1_800_000_060,
      now: 1_800_000_000,
    };
    expect(() => wrapChatMessage({ ...base, maxBackdateSecs: -1 })).toThrow();
    expect(() => wrapChatMessage({ ...base, maxBackdateSecs: 1.5 })).toThrow();
  });
});
