import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli';
import { ShopRateLimiter } from '../src/connectors/http';
import { SHORT_RETRY_MS } from '../src/connectors/scheduler';
import {
  CONFIG_NOT_LOADED,
  ConnectorService,
  isShortRetryOutcome,
} from '../src/connectors/service';
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

describe('phase 4 review round', () => {
  it('answers a Free choice another tab made meanwhile as already active', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const activate = h.directory.activateFree.bind(h.directory);
    vi.spyOn(h.directory, 'activateFree').mockImplementationOnce(async (...args) => {
      // The other tab wins first.
      await activate(...args);
      return activate(...args);
    });
    const late = await h.call('POST', '/v1/shopify/plan/free', { body: {} });
    expect(late).toMatchObject({ status: 200, body: { activation: 'already_active' } });
    expect(await h.directory.statusOf(owner)).toEqual({ status: 'active', tier: TIER.name });
  });

  it('short-retries only a Shopify app connector whose config was not loaded yet', () => {
    const notLoaded = { status: 'error' as const, message: CONFIG_NOT_LOADED };
    expect(isShortRetryOutcome({ via: 'shopify_app' }, notLoaded)).toBe(true);
    expect(isShortRetryOutcome({}, notLoaded)).toBe(false);
    expect(isShortRetryOutcome({ via: 'shopify_app' }, { status: 'error', message: 'boom' })).toBe(
      false,
    );
    expect(
      isShortRetryOutcome(
        { via: 'shopify_app' },
        { status: 'source_closed', url: 'https://x.example', reason: CONFIG_NOT_LOADED },
      ),
    ).toBe(false);
  });

  it('warns about a linked shop on activation only, never on suspend', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await runCli(['store', 'activate', owner, '--tier', TIER.name], { directory: h.directory });
    const suspended = await runCli(['store', 'suspend', owner], { directory: h.directory });
    expect(suspended).not.toContain('Shopify');
  });
});

describe('phase 4 confirm round', () => {
  it('answers an operator change made meanwhile as the standalone admin does', async () => {
    for (const [change, error] of [
      [`update stores set status = 'suspended', tier = $2 where owner = $1`, 'not_pending'],
      [`update stores set tier = $2 where owner = $1`, 'operator_managed'],
    ] as const) {
      const h = await harness();
      const { owner } = await h.onboard();
      vi.spyOn(h.directory, 'activateFree').mockImplementationOnce(async () => {
        await h.db.query(change, [owner, TIER.name]);
        return null;
      });
      expect(await h.call('POST', '/v1/shopify/plan/free', { body: {} })).toMatchObject({
        status: 409,
        body: { error },
      });
    }
  });

  it('has the connector service retry a not-loaded first sync in 30 s, not back off', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.directory.activateFree(owner, TIER.name, NOW, { perDay: 10, maxActive: 10 });
    await h.db.query(
      `insert into leases (owner, holder, epoch, expires_at) values ($1, $2, 1, $3)`,
      [owner, HOLDER, NOW + 600],
    );
    const pending: { callback: () => void; ms: number }[] = [];
    const service = new ConnectorService({
      directory: h.directory,
      holder: HOLDER,
      client: h.relay,
      configFor: () => undefined,
      readConfig: async () => undefined,
      limiter: new ShopRateLimiter(0),
      shopifyApp: h.app,
      timers: {
        setTimeout: (callback, ms) => {
          pending.push({ callback, ms });
          return pending.length;
        },
        clearTimeout: () => undefined,
      },
      now: () => NOW * 1000,
    });
    await service.start();
    // The activation asked for the first import: it is due at once.
    expect(pending.map((timer) => timer.ms)).toEqual([0]);
    pending[0]?.callback();
    await vi.waitFor(async () => {
      const [row] = await h.db.query<{ last_status: { message?: string } | null }>(
        'select last_status from connectors where owner = $1',
        [owner],
      );
      expect(row?.last_status?.message).toBe(CONFIG_NOT_LOADED);
    });
    expect(pending.map((timer) => timer.ms)).toEqual([0, SHORT_RETRY_MS]);
    service.stop();
  });
});
