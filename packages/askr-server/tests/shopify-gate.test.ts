import { buildConfigEvent } from '@elisym/askr';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { NOW, TIER } from './fixtures';
import { PRIMARY, harness } from './shopify-fixtures';

const WRITES: [string, string, unknown][] = [
  ['POST', '/v1/admin/store/assistant/rotate', undefined],
  ['PUT', '/v1/admin/connector', { platform: 'shopify', url: 'https://evil.example' }],
  ['DELETE', '/v1/admin/connector', undefined],
  ['POST', '/v1/admin/connector/preview', undefined],
  ['POST', '/v1/admin/connector/enable', undefined],
  ['POST', '/v1/admin/connector/disable', undefined],
  ['POST', '/v1/admin/catalog', { items: [] }],
  ['PUT', '/v1/admin/policies/returns', { title: 'Returns', body: '30 days' }],
  ['DELETE', '/v1/admin/policies/returns', undefined],
];

describe('the admin API while the Shopify app manages a store (askr-shopify 5.3)', () => {
  it('refuses every write with managed_by_delegate and keeps the reads', async () => {
    const h = await harness();
    const { owner, ownerSecret } = await h.onboard();
    await h.directory.activateFree(owner, TIER.name, NOW, { perDay: 10, maxActive: 10 });
    const store = await h.directory.store(owner);
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: store?.assistant ?? '',
          origins: [PRIMARY],
          name: 'Mine',
          language: 'en',
          currency: 'EUR',
          source: { kind: 'connector', platform: 'shopify', shopUrl: PRIMARY },
          catalogKey: store?.catalogKey ?? '',
          createdAt: NOW + 5,
        },
        ownerSecret,
      ),
      ownerSecret,
    );
    const writes: [string, string, unknown][] = [
      ...WRITES,
      ['POST', '/v1/admin/store/events', { events: [config] }],
    ];
    for (const [method, path, body] of writes) {
      expect([path, await h.admin(method, path, ownerSecret, body)]).toEqual([
        path,
        { status: 409, body: { error: 'managed_by_delegate' } },
      ]);
    }
    const read = await h.admin('GET', '/v1/admin/store', ownerSecret);
    expect(read.status).toBe(200);
    expect(read.body.delegation).toEqual({ linked: true, active: true });
    expect((await h.admin('GET', '/v1/admin/store/events', ownerSecret)).status).toBe(200);
    // Nothing O signed was stored.
    const stored = await h.db.query('select 1 from store_events where id = $1', [config.id]);
    expect(stored).toEqual([]);
  });

  it('opens the routes again once the delegate no longer manages the store', async () => {
    const h = await harness();
    const { owner, ownerSecret } = await h.onboard();
    await h.db.query('update stores set delegate_active = false where owner = $1', [owner]);
    const rotate = await h.admin('POST', '/v1/admin/store/assistant/rotate', ownerSecret);
    expect(rotate.status).toBe(200);
    const read = await h.admin('GET', '/v1/admin/store', ownerSecret);
    expect(read.body.delegation).toEqual({ linked: true, active: false });
  });

  it('names no delegation for a store without a shop, and changes none of its routes', async () => {
    const h = await harness();
    const secret = generateSecretKey();
    const created = await h.admin('POST', '/v1/admin/store', secret);
    expect(created.body.delegation).toEqual({ linked: false, active: false });
    expect(created.body.owner).toBe(getPublicKey(secret));
    const rotate = await h.admin('POST', '/v1/admin/store/assistant/rotate', secret);
    expect(rotate.status).toBe(200);
    const connector = await h.admin('PUT', '/v1/admin/connector', secret, {
      platform: 'shopify',
      url: 'https://plain.example',
    });
    expect(connector.status).toBe(200);
  });
});
