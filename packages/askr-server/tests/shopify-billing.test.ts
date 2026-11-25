import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';
import { HOLDER, NOW, TIER } from './fixtures';
import { BASE, SHOP, harness, nip98 } from './shopify-fixtures';

async function runRequested(h: Awaited<ReturnType<typeof harness>>, owner: string) {
  const [row] = await h.db.query<{ run_requested: boolean }>(
    'select run_requested from connectors where owner = $1',
    [owner],
  );
  return row?.run_requested;
}

describe('Free through the Shopify app (askr-shopify 3.6)', () => {
  it('activates a pending linked store on Free and asks for its first import', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    expect(await runRequested(h, owner)).toBe(false);
    const chosen = await h.call('POST', '/v1/shopify/plan/free', { body: {} });
    expect(chosen).toMatchObject({
      status: 200,
      body: { activation: 'activated', store: { status: 'active', tier: TIER.name } },
    });
    expect(await h.directory.planSourceOf(owner)).toBe('free');
    expect(await runRequested(h, owner)).toBe(true);
    const again = await h.call('POST', '/v1/shopify/plan/free', { body: {} });
    expect(again).toMatchObject({ status: 200, body: { activation: 'already_active' } });
    // A first sync clears the mark.
    await h.directory.saveConnectorStatus(owner, { status: 'ok' }, NOW * 1000, null);
    expect(await runRequested(h, owner)).toBe(false);
  });

  it('refuses Free with the same reasons as the standalone admin', async () => {
    const off = await harness({ freeTier: null });
    await off.onboard();
    expect(await off.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'free_unavailable' },
    });
    const full = await harness({ freeTier: { tier: TIER.name, perDay: 0, maxActive: 10 } });
    await full.onboard();
    expect(await full.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'capacity_reached' },
    });
    const h = await harness();
    const { owner } = await h.onboard();
    await h.db.query(`update stores set tier = $2 where owner = $1`, [owner, TIER.name]);
    expect(await h.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'operator_managed' },
    });
    await h.db.query(`update stores set status = 'suspended' where owner = $1`, [owner]);
    expect(await h.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'not_pending' },
    });
    const bare = await harness();
    const { owner: bareOwner } = await bare.onboard();
    await bare.db.query(
      `delete from store_events where owner = $1 and (event->>'kind')::int = 30496`,
      [bareOwner],
    );
    expect(await bare.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'no_settings' },
    });
  });

  it('refuses Free for an onboarding store and an uninstalled shop; works again after a reinstall', async () => {
    const h = await harness();
    const secret = generateSecretKey();
    const body = { shop: SHOP };
    await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(body),
          createdAt: NOW,
        }),
      },
    });
    expect(await h.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
      status: 409,
      body: { error: 'shopify_onboarding' },
    });
    const linked = await harness();
    const { owner } = await linked.onboard();
    await linked.call('POST', '/v1/shopify/plan/free', { body: {} });
    await linked.webhook('app/uninstalled', {});
    await linked.app.runJobs();
    expect(await linked.directory.statusOf(owner)).toEqual({ status: 'pending', tier: null });
    // The uninstalled shop has no session to call with; the shop row says uninstalled.
    expect((await linked.shops.shop(SHOP))?.uninstalledAt).not.toBeNull();
    await linked.call('GET', '/v1/shopify/store');
    const repicked = await linked.call('POST', '/v1/shopify/plan/free', { body: {} });
    expect(repicked).toMatchObject({ status: 200, body: { activation: 'activated' } });
    expect(await runRequested(linked, owner)).toBe(true);
    expect(getPublicKey(secret)).toHaveLength(64);
  });
});

describe('the standalone admin and operator for a linked store (askr-shopify 3.6)', () => {
  it('refuses the plan choice, checkout and portal for a linked store, installed or not', async () => {
    const h = await harness();
    const { ownerSecret } = await h.onboard();
    for (const path of [
      '/v1/admin/store/plan',
      '/v1/admin/billing/checkout',
      '/v1/admin/billing/portal',
    ]) {
      expect(await h.admin('POST', path, ownerSecret, { plan: 'free' })).toEqual({
        status: 409,
        body: { error: 'shopify_billing' },
      });
    }
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    expect(await h.admin('POST', '/v1/admin/store/plan', ownerSecret, { plan: 'free' })).toEqual({
      status: 409,
      body: { error: 'shopify_billing' },
    });
  });

  it('marks the first import on operator activation and warns', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const printed = await runCli(['store', 'activate', owner, '--tier', TIER.name], {
      directory: h.directory,
    });
    expect(printed).toContain('linked to a Shopify shop');
    expect(await runRequested(h, owner)).toBe(true);
    await h.db.query(
      `insert into leases (owner, holder, epoch, expires_at) values ($1, $2, 1, $3)`,
      [owner, HOLDER, NOW + 600],
    );
    const [scheduled] = await h.directory.scheduledConnectors(HOLDER, NOW, true);
    expect(scheduled?.runFirst).toBe(true);
  });

  it('never marks a connector the app does not manage', async () => {
    const h = await harness();
    const owner = getPublicKey(generateSecretKey());
    await h.directory.createStore(owner, NOW);
    await h.directory.setConnector(owner, {
      platform: 'shopify',
      url: 'https://plain.example',
      importPolicies: true,
    });
    expect(await h.directory.setStatus(owner, 'active', TIER.name)).toBe(true);
    expect(await runRequested(h, owner)).toBe(false);
    const printed = await runCli(['store', 'activate', owner, '--tier', TIER.name], {
      directory: h.directory,
    });
    expect(printed).not.toContain('Shopify');
  });
});
