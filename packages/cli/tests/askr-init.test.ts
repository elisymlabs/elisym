import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as askr from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyFileOf } from '../src/commands/askr/owner-key';
import {
  FREE_TIER,
  INIT_ARGS,
  ORIGIN,
  cleanupHomes,
  harness,
  initInvocation,
  json,
  tempDir,
} from './askr-fake';

// Each case runs whole commands (key files, signing, many calls): slower than a unit under a loaded `bun qa`.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

function postedEvents(calls: { method: string; path: string; body: unknown }[]): NostrEvent[] {
  return calls
    .filter((call) => call.method === 'POST' && call.path === '/v1/admin/store/events')
    .flatMap((call) => {
      const body: { events: NostrEvent[] } = JSON.parse(JSON.stringify(call.body));
      return body.events;
    });
}

describe('askr init', () => {
  it('creates a pending store, signs the config and the hosted authorization, and never chooses a plan', async () => {
    const { fake, run, home } = await harness();
    const outcome = await run(initInvocation({ language: 'de', currency: 'eur' }), INIT_ARGS);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toMatchObject({
      ok: true,
      status: 'pending',
      tier: null,
      awaitingPlan: true,
      created: true,
      config: 'signed',
      authorization: 'signed',
      connector: null,
      published: false,
      ownerKeyFile: keyFileOf(home, 'default'),
    });
    expect(String(outcome.output.next)).toContain('only if the human chose Free');
    // A paid plan: the contact link and the plan name go with the Store ID.
    expect(String(outcome.output.next)).toContain('https://askr.elisym.network/contact');
    expect(String(outcome.output.next)).toContain('the name of the plan');
    expect(outcome.output.upgrade).toMatchObject({
      contact: 'https://askr.elisym.network/contact',
    });
    const events = postedEvents(fake.calls);
    expect(events.map((event) => event.kind)).toEqual([askr.KIND_CONFIG, askr.KIND_CATALOG_AUTH]);
    const [configEvent] = events;
    const config = configEvent === undefined ? undefined : askr.parseConfig(configEvent);
    expect(config).toMatchObject({
      name: 'Example Shop',
      origins: [ORIGIN],
      language: 'de',
      currency: 'EUR',
      source: { kind: 'admin' },
      catalogKey: fake.catalogKey,
      policyKey: fake.catalogKey,
      assistant: fake.assistant,
    });
    expect(fake.routeCalls('POST /v1/admin/store/plan')).toHaveLength(0);
  });

  it('writes the key file 0600 in a 0700 directory before the first call, and a re-run after a failed POST reuses it', async () => {
    const { fake, run, home } = await harness();
    let failures = 1;
    fake.on('POST /v1/admin/store', () => {
      if (failures > 0) {
        failures -= 1;
        return json({ error: 'unavailable' }, 503);
      }
      return undefined;
    });
    // The fake's own store creation happens in its NIP-98 layer, so fail the GET instead.
    fake.on('GET /v1/admin/store', () => (failures > 0 ? json({ error: 'x' }, 503) : undefined));
    const first = await run(initInvocation(), INIT_ARGS);
    expect(first.exitCode).toBe(4);
    const path = keyFileOf(home, 'default');
    const saved = await readFile(path, 'utf-8');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.elisym', '.askr'))).mode & 0o777).toBe(0o700);
    failures = 0;
    const second = await run(initInvocation(), INIT_ARGS);
    expect(second.exitCode).toBe(0);
    expect(await readFile(path, 'utf-8')).toBe(saved);
    expect(first.output.resume).toBe(
      `npx -y @elisym/cli@latest askr init --name 'Example Shop' --origin ${ORIGIN}`,
    );
    expect(second.output.storeId).toBe(JSON.parse(saved).storeId);
  });

  it('re-run with no flags: config unchanged, nothing posted; a changed voice signs one new 30496 and no 30497', async () => {
    const { fake, run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    const before = postedEvents(fake.calls).length;
    const again = await run({ command: 'init', options: {} }, ['init']);
    expect(again.output).toMatchObject({ config: 'unchanged', authorization: 'present' });
    expect(postedEvents(fake.calls)).toHaveLength(before);
    const dir = await tempDir();
    const voice = join(dir, 'voice.txt');
    await writeFile(voice, 'Warm and short.');
    const voiced = await run({ command: 'init', options: { voiceFile: voice } }, ['init']);
    expect(voiced.output).toMatchObject({ config: 'signed', authorization: 'present' });
    const added = postedEvents(fake.calls).slice(before);
    expect(added.map((event) => event.kind)).toEqual([askr.KIND_CONFIG]);
  });

  it('--launcher-text signs the chat button text, keeps it when left out and clears it with ""', async () => {
    const { fake, run } = await harness();
    function latestConfig(): NostrEvent | undefined {
      return postedEvents(fake.calls)
        .filter((event) => event.kind === askr.KIND_CONFIG)
        .at(-1);
    }
    function latestText(): string | undefined {
      const latest = latestConfig();
      return latest === undefined ? undefined : askr.parseConfig(latest)?.launcherText;
    }
    const created = await run(initInvocation({ launcherText: ' Ask us ' }), INIT_ARGS);
    expect(created.exitCode).toBe(0);
    expect(latestText()).toBe('Ask us');
    const changed = await run({ command: 'init', options: { launcherText: 'Ask our guide' } }, [
      'init',
    ]);
    expect(changed.output).toMatchObject({ config: 'signed' });
    expect(latestText()).toBe('Ask our guide');
    const kept = await run({ command: 'init', options: { greeting: 'Hi' } }, ['init']);
    expect(kept.output).toMatchObject({ config: 'signed' });
    expect(latestText()).toBe('Ask our guide');
    const cleared = await run({ command: 'init', options: { launcherText: '' } }, ['init']);
    expect(cleared.output).toMatchObject({ config: 'signed' });
    expect(latestConfig()?.tags.some((tag) => tag[0] === 'launcher-text')).toBe(false);
  });

  it('a --launcher-text over the limit is invalid_flag, nothing posted', async () => {
    const { fake, run } = await harness();
    const outcome = await run(initInvocation({ launcherText: 'a'.repeat(25) }), INIT_ARGS);
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_flag' } } });
    expect(JSON.stringify(outcome.output)).toContain('--launcher-text');
    expect(postedEvents(fake.calls)).toHaveLength(0);
  });

  it('signs only the 30497 when the authorization is missing and the config is unchanged', async () => {
    const { fake, run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    fake.stored = fake.stored.filter((entry) => entry.event.kind !== askr.KIND_CATALOG_AUTH);
    const before = postedEvents(fake.calls).length;
    const again = await run({ command: 'init', options: {} }, ['init']);
    expect(again.output).toMatchObject({ config: 'unchanged', authorization: 'signed' });
    expect(
      postedEvents(fake.calls)
        .slice(before)
        .map((event) => event.kind),
    ).toEqual([askr.KIND_CATALOG_AUTH]);
  });

  it('refuses a different name or origins without --update (exit 6), signs with --update', async () => {
    const { run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    const renamed = await run(initInvocation({ name: 'Other Shop' }), [
      'init',
      '--name',
      'Other Shop',
    ]);
    expect(renamed.exitCode).toBe(6);
    expect(renamed.output).toMatchObject({
      ok: false,
      error: { code: 'existing_store' },
      name: 'Example Shop',
      origins: [ORIGIN],
    });
    expect(String(renamed.output.existingStore)).toMatch(/^npub1/);
    const updated = await run(initInvocation({ name: 'Other Shop', update: true }), ['init']);
    expect(updated.exitCode).toBe(0);
    expect(updated.output.config).toBe('signed');
  });

  it('--profile b creates a second store with its own key file', async () => {
    const { run, home } = await harness();
    const first = await run(initInvocation(), INIT_ARGS);
    // The second store is another owner's: a fresh fake server, the same computer.
    const other = await harness(undefined, home);
    const second = await other.run(initInvocation(), [...INIT_ARGS, '--profile', 'b'], 'b');
    expect(second.exitCode).toBe(0);
    expect(second.output.ownerKeyFile).toBe(keyFileOf(home, 'b'));
    expect(second.output.storeId).not.toBe(first.output.storeId);
  });

  it('refuses a moved store with no own config (moved_store, exit 3)', async () => {
    const { fake, run } = await harness();
    fake.movedFrom = getPublicKey(generateSecretKey());
    const outcome = await run(initInvocation(), INIT_ARGS);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toMatchObject({ error: { code: 'moved_store' } });
  });

  it('applies defaults only without a previous config and keeps the previous source, policy key and private part', async () => {
    const { fake, run } = await harness();
    const voice = join(await tempDir(), 'voice.txt');
    await writeFile(voice, 'Calm and exact.');
    await run(
      initInvocation({
        source: 'connector',
        platform: 'shopify',
        shopUrl: `${ORIGIN}/`,
        voiceFile: voice,
      }),
      INIT_ARGS,
    );
    const [config] = postedEvents(fake.calls);
    expect(config).toBeDefined();
    const parsed = config === undefined ? undefined : askr.parseConfig(config);
    expect(parsed?.source).toEqual({ kind: 'connector', platform: 'shopify', shopUrl: ORIGIN });
    const again = await run({ command: 'init', options: { greeting: 'Hi' } }, ['init']);
    expect(again.exitCode).toBe(0);
    const latest = postedEvents(fake.calls).at(-1);
    const merged = latest === undefined ? undefined : askr.parseConfig(latest);
    expect(merged).toMatchObject({
      source: { kind: 'connector', platform: 'shopify' },
      language: 'en',
      currency: 'USD',
      greeting: 'Hi',
    });
    expect(
      merged === undefined ? undefined : askr.decryptPrivateConfig(merged, fake.assistantSecret),
    ).toEqual({ voice: 'Calm and exact.', instructions: '', notes: '' });
  });

  it('keeps a policy key other than server K while the source and catalog key stay', async () => {
    const { fake, run, home } = await harness();
    await run(initInvocation(), INIT_ARGS);
    const key = JSON.parse(await readFile(keyFileOf(home, 'default'), 'utf-8'));
    const secret = Uint8Array.from(Buffer.from(key.secretKey, 'hex'));
    const ownPolicyKey = getPublicKey(generateSecretKey());
    const signed = finalizeEvent(
      askr.buildConfigEvent(
        {
          assistant: fake.assistant,
          origins: [ORIGIN],
          name: 'Example Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: fake.catalogKey,
          policyKey: ownPolicyKey,
          createdAt: Math.floor(Date.now() / 1000) + 5,
        },
        secret,
      ),
      secret,
    );
    fake.stored.push({ event: signed, published: false, stopped: false });
    const again = await run({ command: 'init', options: { greeting: 'Hello' } }, ['init']);
    expect(again.exitCode).toBe(0);
    const latest = postedEvents(fake.calls).at(-1);
    expect(latest === undefined ? undefined : askr.parseConfig(latest)?.policyKey).toBe(
      ownPolicyKey,
    );
  });

  it('refuses a previous config with source catalog (catalog_source, exit 3)', async () => {
    const { fake, run, home } = await harness();
    await run(initInvocation(), INIT_ARGS);
    const key = JSON.parse(await readFile(keyFileOf(home, 'default'), 'utf-8'));
    const secret = Uint8Array.from(Buffer.from(key.secretKey, 'hex'));
    const merchantKey = getPublicKey(generateSecretKey());
    fake.stored.push({
      event: finalizeEvent(
        askr.buildConfigEvent(
          {
            assistant: fake.assistant,
            origins: [ORIGIN],
            name: 'Example Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: merchantKey,
            createdAt: Math.floor(Date.now() / 1000) + 5,
          },
          secret,
        ),
        secret,
      ),
      published: false,
      stopped: false,
    });
    const outcome = await run({ command: 'init', options: {} }, ['init']);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toMatchObject({ error: { code: 'catalog_source' } });
  });

  it('checks the connector before signing: google without a feed URL is exit 1 and nothing is posted', async () => {
    const { fake, run } = await harness();
    const outcome = await run(
      initInvocation({ source: 'connector', platform: 'google' }),
      INIT_ARGS,
    );
    expect(outcome.exitCode).toBe(1);
    expect(postedEvents(fake.calls)).toHaveLength(0);
  });

  it('reconciles the connector on every run, carrying feed, currency and importPolicies', async () => {
    const { fake, run } = await harness();
    await run(
      initInvocation({
        source: 'connector',
        platform: 'google',
        feedUrl: 'https://shop.example/feed.xml',
      }),
      INIT_ARGS,
    );
    expect(fake.routeCalls('PUT /v1/admin/connector')[0]?.body).toEqual({
      platform: 'google',
      url: 'https://shop.example/feed.xml',
      importPolicies: false,
    });
    if (fake.connector !== null) {
      fake.connector.currency = 'EUR';
      fake.connector.enabled = true;
    }
    const again = await run({ command: 'init', options: {} }, ['init']);
    expect(again.output).toMatchObject({
      config: 'unchanged',
      connector: { platform: 'google', enabled: true },
    });
    expect(fake.routeCalls('PUT /v1/admin/connector')[1]?.body).toEqual({
      platform: 'google',
      url: 'https://shop.example/feed.xml',
      currency: 'EUR',
      importPolicies: false,
    });
  });

  it('a new Shopify connector imports policies; --source admin over a connector deletes it', async () => {
    const { fake, run } = await harness();
    await run(
      initInvocation({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN }),
      INIT_ARGS,
    );
    expect(fake.routeCalls('PUT /v1/admin/connector')[0]?.body).toEqual({
      platform: 'shopify',
      url: ORIGIN,
      importPolicies: true,
    });
    const admin = await run({ command: 'init', options: { source: 'admin' } }, ['init']);
    expect(admin.exitCode).toBe(0);
    expect(fake.routeCalls('DELETE /v1/admin/connector')).toHaveLength(1);
    const latest = postedEvents(fake.calls).at(-1);
    expect(latest === undefined ? undefined : askr.parseConfig(latest)?.source).toEqual({
      kind: 'admin',
    });
  });

  it('re-signs a stopped event once; still stopped after the wait is publish_stopped (exit 3)', async () => {
    const { fake, run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    fake.status = 'active';
    fake.tier = FREE_TIER;
    for (const entry of fake.stored) {
      entry.stopped = true;
    }
    fake.on('POST /v1/admin/store/events', () => {
      // The relay keeps refusing: what is stored again stops again.
      setTimeout(() => {
        for (const entry of fake.stored) {
          entry.stopped = !entry.published;
        }
      }, 0);
      return undefined;
    });
    fake.holdPublication = true;
    const before = postedEvents(fake.calls).length;
    // The same init line again: what stopped is signed and stored once more.
    const outcome = await run(initInvocation(), INIT_ARGS);
    expect(postedEvents(fake.calls).length).toBe(before + 2);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toMatchObject({ error: { code: 'publish_stopped' } });
  });

  it('on an active store waits for publication; never published by the deadline is exit 4 with resume', async () => {
    const { fake, run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    fake.status = 'active';
    fake.tier = FREE_TIER;
    fake.holdPublication = true;
    const started = Date.now();
    const outcome = await run(initInvocation({ greeting: 'Hi' }), [
      ...INIT_ARGS,
      '--greeting',
      'Hi',
    ]);
    expect(Date.now() - started).toBeLessThanOrEqual(85_000);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.output).toMatchObject({
      published: false,
      resume: `npx -y @elisym/cli@latest askr init --name 'Example Shop' --origin ${ORIGIN} --greeting Hi`,
    });
    fake.holdPublication = false;
    fake.publish();
    const resumed = await run({ command: 'init', options: {} }, ['init']);
    expect(resumed.output).toMatchObject({ published: true, status: 'active' });
  });

  it('never sends POST /store/plan; rate_limited is exit 3 with the one-hour hint', async () => {
    const { fake, run } = await harness();
    fake.on('POST /v1/admin/store', () => json({ error: 'rate_limited' }, 429));
    fake.on('GET /v1/admin/store', () => json({ error: 'no_store' }, 404));
    const outcome = await run(initInvocation(), INIT_ARGS);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toMatchObject({
      error: {
        code: 'rate_limited',
        hint: 'too many new stores from this network; try again in an hour',
      },
    });
    expect(fake.routeCalls('POST /v1/admin/store/plan')).toHaveLength(0);
  });

  it('bad_event config_assistant and stale_config are exit 4 resuming the same line; future is the clock hint', async () => {
    for (const [reason, exitCode] of [
      ['config_assistant', 4],
      ['stale_config', 4],
      ['future', 3],
    ] as const) {
      const { fake, run } = await harness();
      fake.on('POST /v1/admin/store/events', () =>
        json({ error: 'bad_event', reason, id: 'x' }, 400),
      );
      const outcome = await run(initInvocation(), INIT_ARGS);
      expect(outcome.exitCode).toBe(exitCode);
      if (exitCode === 4) {
        expect(outcome.output.resume).toBe(
          `npx -y @elisym/cli@latest askr init --name 'Example Shop' --origin ${ORIGIN}`,
        );
      } else {
        expect(JSON.stringify(outcome.output)).toContain('clock');
      }
    }
  });

  it('a stale NIP-98 answer gives the clock hint', async () => {
    const { fake, run } = await harness();
    fake.on('GET /v1/admin/store', () => json({ error: 'unauthorized', reason: 'stale' }, 401));
    const outcome = await run(initInvocation(), INIT_ARGS);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toMatchObject({ error: { code: 'stale' } });
    expect(JSON.stringify(outcome.output)).toContain('clock');
  });

  it('signs every request afresh: no NIP-98 event id is sent twice', async () => {
    const { fake, run } = await harness();
    await run(initInvocation(), INIT_ARGS);
    const ids = fake.calls.flatMap((call) => (call.authId === undefined ? [] : [call.authId]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
