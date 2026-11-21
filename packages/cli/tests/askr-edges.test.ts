import { link, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as askr from '@elisym/askr';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyDirOf,
  keyFileOf,
  readImportedKey,
  readOwnerKey,
  saveOwnerKey,
} from '../src/commands/askr/owner-key';
import { readListings, readPolicySlugs, readSigned } from '../src/commands/askr/read';
import { Session } from '../src/commands/askr/session';
import {
  INIT_ARGS,
  ORIGIN,
  activeStore,
  cleanupHomes,
  drive,
  harness,
  initInvocation,
  json,
  product,
  tempDir,
  writeCsv,
  writeJson,
  type Call,
  type Harness,
} from './askr-fake';

vi.setConfig({ testTimeout: 30_000 });

const NOT_AUTHORIZED = 'This key is not authorized as a catalog key by the store owner';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function postedEvents(calls: readonly Call[]): NostrEvent[] {
  return calls
    .filter((call) => call.method === 'POST' && call.path === '/v1/admin/store/events')
    .flatMap((call) => {
      const body: { events: NostrEvent[] } = JSON.parse(JSON.stringify(call.body));
      return body.events;
    });
}

async function ownerSecret(setup: Harness, profile = 'default'): Promise<Uint8Array> {
  const key = await readOwnerKey(setup.home, profile);
  if (key === undefined) {
    throw new Error('no key');
  }
  return key.secretKey;
}

function configBy(
  secret: Uint8Array,
  setup: Harness,
  overrides: Partial<askr.StoreConfigInput> = {},
): NostrEvent {
  return finalizeEvent(
    askr.buildConfigEvent(
      {
        assistant: setup.fake.assistant,
        origins: [ORIGIN],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'admin' },
        catalogKey: setup.fake.catalogKey,
        createdAt: nowSecs(),
        ...overrides,
      },
      secret,
    ),
    secret,
  );
}

/** The same event with a tag changed after signing: its id and signature no longer hold. */
function forged(event: NostrEvent, tag: string, value: string): NostrEvent {
  return {
    ...event,
    tags: event.tags.map((entry) => (entry[0] === tag ? [tag, value] : entry)),
  };
}

function signedAt(template: EventTemplate, secret: Uint8Array, createdAt: number): NostrEvent {
  return finalizeEvent({ ...template, created_at: createdAt }, secret);
}

describe('init edges', () => {
  it('S1: other origins without --update are existing_store, exit 6, nothing signed', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const before = postedEvents(setup.fake.calls).length;
    const outcome = await setup.run(
      { command: 'init', options: { origin: ['https://other.example'] } },
      ['init', '--origin', 'https://other.example'],
    );
    expect(outcome).toMatchObject({ exitCode: 6, output: { error: { code: 'existing_store' } } });
    expect(postedEvents(setup.fake.calls)).toHaveLength(before);
  });

  it('S2: a stopped 30496 over an equal published config is signed again, not reported stopped at once', async () => {
    const setup = await activeStore();
    const secret = await ownerSecret(setup);
    // Newer than the relay's, stopped: the server never hands it back, so the relay's config is read.
    setup.fake.stored.push({
      event: configBy(secret, setup, { currency: 'EUR', createdAt: nowSecs() + 1 }),
      published: false,
      stopped: true,
    });
    const before = postedEvents(setup.fake.calls).length;
    const outcome = await setup.run({ command: 'init', options: {} }, ['init']);
    expect(outcome).toMatchObject({ exitCode: 0, output: { config: 'signed', published: true } });
    expect(
      postedEvents(setup.fake.calls)
        .slice(before)
        .map((event) => event.kind),
    ).toEqual([askr.KIND_CONFIG]);
  });

  it('S3: a new config and 30497 are dated after a previous one dated ahead', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const secret = await ownerSecret(setup);
    const ahead = nowSecs() + 300;
    setup.fake.stored = [
      { event: configBy(secret, setup, { createdAt: ahead }), published: false, stopped: false },
      {
        event: finalizeEvent(askr.buildCatalogRevocation(setup.fake.catalogKey, ahead), secret),
        published: false,
        stopped: false,
      },
    ];
    const before = postedEvents(setup.fake.calls).length;
    const outcome = await setup.run({ command: 'init', options: { greeting: 'Hi' } }, ['init']);
    expect(outcome.output).toMatchObject({ config: 'signed', authorization: 'signed' });
    const added = postedEvents(setup.fake.calls).slice(before);
    expect(added.map((event) => [event.kind, event.created_at])).toEqual([
      [askr.KIND_CONFIG, ahead + 1],
      [askr.KIND_CATALOG_AUTH, ahead + 1],
    ]);
  });

  it('S4: a shop address whose origin is not an --origin is exit 1, nothing posted', async () => {
    const setup = await harness();
    const outcome = await setup.run(
      initInvocation({
        source: 'connector',
        platform: 'shopify',
        shopUrl: 'https://other-shop.example',
      }),
      INIT_ARGS,
    );
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_flag' } } });
    expect(JSON.stringify(outcome.output)).toContain(
      'add https://other-shop.example as an --origin',
    );
    expect(postedEvents(setup.fake.calls)).toHaveLength(0);
  });

  it('S5: a kept policy key is reset to server K when the source kind changes', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const secret = await ownerSecret(setup);
    const ownPolicyKey = getPublicKey(generateSecretKey());
    setup.fake.stored.push({
      event: configBy(secret, setup, { policyKey: ownPolicyKey, createdAt: nowSecs() + 5 }),
      published: false,
      stopped: false,
    });
    const outcome = await setup.run(
      { command: 'init', options: { source: 'connector', platform: 'shopify', shopUrl: ORIGIN } },
      ['init'],
    );
    expect(outcome.exitCode).toBe(0);
    const latest = postedEvents(setup.fake.calls).at(-1);
    expect(latest === undefined ? undefined : askr.parseConfig(latest)?.policyKey).toBe(
      setup.fake.catalogKey,
    );
  });

  it('S6: an imported key is refused when another run saved a different key first', async () => {
    const setup = await harness();
    const dir = await tempDir();
    const imported = join(dir, 'key.txt');
    const importedSecret = generateSecretKey();
    await writeFile(imported, bytesToHex(importedSecret));
    setup.fake.owner = getPublicKey(importedSecret);
    setup.deps.keyFileOps = {
      link: async (existingPath, newPath) => {
        // Another run wins the race between this run's read and its save.
        await saveOwnerKey(setup.home, 'default', generateSecretKey(), 1);
        await link(existingPath, newPath);
      },
    };
    const outcome = await setup.run(initInvocation({ ownerKeyFile: imported }), INIT_ARGS);
    expect(outcome).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'profile_has_other_key' } },
    });
    expect(setup.fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/admin/store',
    ]);
  });

  it("D1: --owner-key-file reads this CLI's own key file by its secretKey, never its owner", async () => {
    const setup = await harness();
    const first = await setup.run(initInvocation(), INIT_ARGS);
    const adopted = await setup.run(
      initInvocation({ ownerKeyFile: keyFileOf(setup.home, 'default') }),
      [...INIT_ARGS, '--profile', 'copy'],
      'copy',
    );
    expect(adopted.exitCode).toBe(0);
    expect(adopted.output.storeId).toBe(first.output.storeId);
  });

  it('D1: a file with several keys, or a secretKey that is not its owner, is refused', async () => {
    const dir = await tempDir();
    const several = join(dir, 'several.txt');
    await writeFile(
      several,
      `${bytesToHex(generateSecretKey())}\n${bytesToHex(generateSecretKey())}\n`,
    );
    await expect(readImportedKey(several)).rejects.toMatchObject({ code: 'key_file_unreadable' });
    const mismatched = join(dir, 'mismatched.json');
    await writeFile(
      mismatched,
      JSON.stringify({
        owner: getPublicKey(generateSecretKey()),
        secretKey: bytesToHex(generateSecretKey()),
      }),
    );
    await expect(readImportedKey(mismatched)).rejects.toMatchObject({
      code: 'key_file_unreadable',
    });
    const secret = generateSecretKey();
    const own = join(dir, 'own.json');
    await writeFile(
      own,
      JSON.stringify({ owner: getPublicKey(secret), secretKey: bytesToHex(secret) }),
    );
    expect(bytesToHex(await readImportedKey(own))).toBe(bytesToHex(secret));
  });

  it('S12: a key file another run is still writing is read once complete, within 2 s, else refused', async () => {
    const home = await tempDir();
    const saved = await saveOwnerKey(home, 'default', generateSecretKey(), 1);
    const whole = await readFile(saved.path, 'utf-8');
    await writeFile(saved.path, whole.slice(0, 20));
    setTimeout(() => {
      void writeFile(saved.path, whole);
    }, 500);
    expect((await drive(readOwnerKey(home, 'default')))?.owner).toBe(saved.owner);
    await writeFile(saved.path, whole.slice(0, 20));
    const started = Date.now();
    await expect(drive(readOwnerKey(home, 'default'))).rejects.toMatchObject({
      code: 'key_file_unreadable',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  });
});

describe('products edges', () => {
  function realCalls(setup: Harness): Call[] {
    return setup.fake
      .routeCalls('POST /v1/admin/catalog')
      .filter((call) => JSON.stringify(call.body).includes('"dryRun":false'));
  }

  it('S7: a dry run with nothing to change sends no real catalog call', async () => {
    const setup = await activeStore();
    const file = await writeJson([product('a')]);
    await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(realCalls(setup)).toHaveLength(1);
    const again = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(again.output).toMatchObject({ unchanged: 1, sync: 'done' });
    expect(realCalls(setup)).toHaveLength(1);
  });

  it('S9: the absent-products warning: more than 20% or more than 10, not at either bound', async () => {
    const cases: Array<[number, number, boolean]> = [
      [50, 10, false],
      [100, 11, true],
      [20, 5, true],
      [100, 10, false],
    ];
    for (const [listed, absent, warned] of cases) {
      const setup = await activeStore();
      setup.fake.tier = { name: 'big', maxProducts: 1_000, branding: true };
      const items = Array.from({ length: listed }, (_, index) => product(`p${index}`));
      setup.fake.seedProducts(items);
      const file = await writeJson(items.slice(absent));
      const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
      expect(outcome.output.warning !== undefined, `${listed}/${absent}`).toBe(warned);
    }
  });

  it('S9: the not-authorized retry waits 2 s, then twice as long each time', async () => {
    const setup = await activeStore();
    const times: number[] = [];
    let refusals = 3;
    setup.fake.on('POST /v1/admin/catalog', () => {
      times.push(Date.now());
      if (refusals > 0) {
        refusals -= 1;
        return json({ error: 'sync_refused', message: NOT_AUTHORIZED }, 409);
      }
      return undefined;
    });
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.exitCode).toBe(0);
    const gaps = times.slice(1, 4).map((time, index) => time - (times[index] ?? 0));
    expect(gaps).toEqual([2_000, 4_000, 8_000]);
  });
});

describe('S11: resume lines', () => {
  it('a resume of another command keeps --profile', async () => {
    const setup = await harness();
    await setup.run(
      initInvocation({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN }),
      [...INIT_ARGS, '--profile', 'shop2'],
      'shop2',
    );
    await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free'], 'shop2');
    setup.fake.on('POST /v1/admin/connector/preview', () => new Promise<Response>(() => undefined));
    const outcome = await setup.run(
      { command: 'connector' },
      ['connector', '--profile', 'shop2'],
      'shop2',
    );
    expect(outcome.output.resume).toBe('npx -y @elisym/cli@latest askr connector --profile shop2');
  });
});

describe('S10: reads trust only genuine events', () => {
  async function sessionFor(
    setup: Harness,
    allEvents = false,
  ): Promise<{ session: Session; secret: Uint8Array }> {
    const secret = generateSecretKey();
    setup.fake.owner = getPublicKey(secret);
    if (allEvents) {
      // A relay that answers with everything it has: the reader's own checks must hold.
      setup.deps.connectRelay = async () => ({
        query: async () => setup.fake.relay,
        close: () => undefined,
      });
    }
    const session = new Session({ askr, deps: setup.deps, profile: 'default', args: [] });
    session.signAs(secret);
    return { session, secret };
  }

  it('readSigned: a forged, a wrong-author and a far-future config are never the newest', async () => {
    const setup = await harness();
    const { session, secret } = await sessionFor(setup, true);
    const now = nowSecs();
    const genuine = configBy(secret, setup, { name: 'Genuine', createdAt: now - 10 });
    setup.fake.relay.push(
      genuine,
      forged(configBy(secret, setup, { name: 'Forged', createdAt: now }), 'name', 'Forged!'),
      configBy(generateSecretKey(), setup, { name: 'Stranger', createdAt: now }),
      configBy(secret, setup, { name: 'Ahead', createdAt: now + 20 * 60 }),
    );
    setup.fake.stored.push({
      event: configBy(generateSecretKey(), setup, { name: 'Stored stranger', createdAt: now }),
      published: false,
      stopped: false,
    });
    const signed = await drive(readSigned(session, getPublicKey(secret), secret));
    expect(signed.config?.name).toBe('Genuine');
  });

  it('readListings and readPolicySlugs: forged, wrong-author and same-second-deleted events are left out', async () => {
    const setup = await harness();
    const { session } = await sessionFor(setup, true);
    const now = nowSecs();
    const key = setup.fake.catalogKey;
    const stranger = generateSecretKey();
    const listing = (d: string) => askr.buildCatalogItemEvent({ ...product(d), createdAt: now });
    const policy = (slug: string) =>
      askr.buildPolicyEvent({ slug, title: slug, body: 'text', createdAt: now });
    const deletion = (address: string): EventTemplate => ({
      kind: 5,
      created_at: now,
      tags: [['a', address]],
      content: '',
    });
    setup.fake.relay.push(
      setup.fake.signedByK(listing('a')),
      forged(setup.fake.signedByK(listing('b')), 'title', 'Forged'),
      finalizeEvent(listing('c'), stranger),
      setup.fake.signedByK(listing('d')),
      setup.fake.signedByK(deletion(`30402:${key}:d`)),
      finalizeEvent(deletion(`30402:${key}:a`), stranger),
      signedAt(listing('e'), setup.fake.catalogSecret, now + 60 * 60),
      setup.fake.signedByK(policy('returns')),
      forged(setup.fake.signedByK(policy('faq')), 'title', 'Forged'),
      finalizeEvent(policy('terms'), stranger),
      setup.fake.signedByK(policy('shipping')),
      setup.fake.signedByK(deletion(`${askr.KIND_POLICY}:${key}:shipping`)),
      signedAt(policy('warranty'), setup.fake.catalogSecret, now + 60 * 60),
    );
    const listings = await drive(readListings(session, key));
    // A listing dated ahead still counts against the plan, as the server counts it.
    expect([...listings.listed].sort()).toEqual(['a', 'e']);
    expect(await drive(readPolicySlugs(session, key))).toEqual(['returns']);
  });
});

describe('round 2: imports, CSV file errors, inactive stores, status', () => {
  it('D4: JSON without a secretKey is refused, never adopted from its public keys', async () => {
    const dir = await tempDir();
    const secret = generateSecretKey();
    const owner = getPublicKey(secret);
    for (const [name, content] of [
      ['owner.json', { owner, storeId: nip19.npubEncode(owner) }],
      ['pubkey.json', { pubkey: owner }],
      [
        'other-store.json',
        {
          secretKey: bytesToHex(secret),
          storeId: nip19.npubEncode(getPublicKey(generateSecretKey())),
        },
      ],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(content));
      await expect(readImportedKey(path), name).rejects.toMatchObject({
        code: 'key_file_unreadable',
      });
    }
  });

  it("D4: an admin-style file whose Store ID is not its nsec's is refused; a matching one is read", async () => {
    const dir = await tempDir();
    const secret = generateSecretKey();
    const other = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const mismatched = join(dir, 'mismatched.txt');
    await writeFile(mismatched, `Secret key: ${nip19.nsecEncode(secret)}\nStore ID: ${other}\n`);
    await expect(readImportedKey(mismatched)).rejects.toMatchObject({
      code: 'key_file_unreadable',
    });
    const matching = join(dir, 'matching.txt');
    const storeId = nip19.npubEncode(getPublicKey(secret));
    await writeFile(
      matching,
      `\uFEFFSecret key: ${nip19.nsecEncode(secret)}\nStore ID: ${storeId}\n`,
    );
    expect(bytesToHex(await readImportedKey(matching))).toBe(bytesToHex(secret));
  });

  it('accepts an nsec with the same key in hex, a BOM before JSON, and refuses a directory or a huge file', async () => {
    const dir = await tempDir();
    const secret = generateSecretKey();
    const both = join(dir, 'both.txt');
    await writeFile(both, `${nip19.nsecEncode(secret)}\n${bytesToHex(secret)}\n`);
    expect(bytesToHex(await readImportedKey(both))).toBe(bytesToHex(secret));
    const bom = join(dir, 'bom.json');
    await writeFile(
      bom,
      `\uFEFF${JSON.stringify({ owner: getPublicKey(secret), secretKey: bytesToHex(secret) })}`,
    );
    expect(bytesToHex(await readImportedKey(bom))).toBe(bytesToHex(secret));
    await expect(readImportedKey(dir)).rejects.toMatchObject({ code: 'key_file_unreadable' });
    const huge = join(dir, 'huge.txt');
    await writeFile(huge, `${bytesToHex(secret)}\n${' '.repeat(70 * 1024)}`);
    await expect(readImportedKey(huge)).rejects.toMatchObject({ code: 'key_file_unreadable' });
  });

  it('a key file another run saved with a BOM is read', async () => {
    const home = await tempDir();
    const saved = await saveOwnerKey(home, 'default', generateSecretKey(), 1);
    await writeFile(saved.path, `\uFEFF${await readFile(saved.path, 'utf-8')}`);
    expect((await drive(readOwnerKey(home, 'default')))?.owner).toBe(saved.owner);
  });

  it('N1: an import refusal through init is exit 2, with nothing sent', async () => {
    const setup = await harness();
    const path = join(await tempDir(), 'public.json');
    await writeFile(path, JSON.stringify({ owner: getPublicKey(generateSecretKey()) }));
    const outcome = await setup.run(initInvocation({ ownerKeyFile: path }), INIT_ARGS);
    expect(outcome).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'key_file_unreadable' } },
    });
    expect(setup.fake.calls).toHaveLength(0);
  });

  it('S13: a CSV with a file-level problem is invalid_file with its fileErrors in a field', async () => {
    const setup = await activeStore();
    const file = await writeCsv('d,title\na,A\n');
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_file' } } });
    const fileErrors = outcome.output.fileErrors;
    expect(Array.isArray(fileErrors) && fileErrors.length > 0).toBe(true);
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);
  });

  it('N4: products on a store that is not active refuse from the view, before reading the CSV rows, with no catalog call', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const file = await writeCsv('d,title\na,A\n');
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 5, output: { error: { code: 'inactive' } } });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);
  });

  it('status prints the language and currency an update proposes to keep', async () => {
    const setup = await harness();
    await setup.run(initInvocation({ language: 'de', currency: 'CHF' }), INIT_ARGS);
    const outcome = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(outcome.output).toMatchObject({ language: 'de', currency: 'CHF', name: 'Example Shop' });
  });
});

describe('round 3: an imported key must own a store', () => {
  it('a file holding only a public key, in any shape, is refused through init: exit 2, nothing saved or posted', async () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const shapes: Array<[string, string]> = [
      ['bare.txt', `${pub}\n`],
      ['labelled.txt', `Public key: ${pub}\n`],
      ['array.json', JSON.stringify([pub])],
      ['string.json', JSON.stringify(pub)],
      ['owner.yaml', `owner: ${pub}\n`],
      ['.env', `NOSTR_PUBKEY=${pub}\n`],
      ['broken.json', `{"owner":"${pub}"`],
    ];
    for (const [name, content] of shapes) {
      const setup = await harness();
      // The store exists, owned by the real secret key the file does not hold.
      setup.fake.owner = pub;
      const path = join(await tempDir(), name);
      await writeFile(path, content);
      const outcome = await setup.run(initInvocation({ ownerKeyFile: path }), INIT_ARGS);
      expect(outcome.exitCode, name).toBe(2);
      expect(outcome.output, name).toMatchObject({ error: { code: 'no_store_for_key' } });
      expect(await readOwnerKey(setup.home, 'default'), name).toBeUndefined();
      expect(
        setup.fake.calls.map((call) => `${call.method} ${call.path}`),
        name,
      ).toEqual(['GET /v1/admin/store']);
    }
  });

  it('a real key file of an existing store is still adopted', async () => {
    const setup = await harness();
    const secret = generateSecretKey();
    setup.fake.owner = getPublicKey(secret);
    const path = join(await tempDir(), 'askr-secret-key.txt');
    await writeFile(
      path,
      `Secret key: ${nip19.nsecEncode(secret)}\nStore ID: ${nip19.npubEncode(getPublicKey(secret))}\n`,
    );
    const outcome = await setup.run(initInvocation({ ownerKeyFile: path }), INIT_ARGS);
    expect(outcome).toMatchObject({
      exitCode: 0,
      output: { storeId: nip19.npubEncode(getPublicKey(secret)), created: false },
    });
    expect((await readOwnerKey(setup.home, 'default'))?.owner).toBe(getPublicKey(secret));
  });

  it('a zero key is refused in text and JSON; uppercase hex is read in both; an nsec beside its own public key is one key', async () => {
    const dir = await tempDir();
    const zero = '0'.repeat(64);
    for (const [name, content] of [
      ['zero.txt', zero],
      ['zero.json', JSON.stringify({ secretKey: zero })],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, content);
      await expect(readImportedKey(path), name).rejects.toMatchObject({
        code: 'key_file_unreadable',
        exitCode: 2,
      });
    }
    const secret = generateSecretKey();
    const upper = bytesToHex(secret).toUpperCase();
    for (const [name, content] of [
      ['upper.txt', upper],
      ['upper.json', JSON.stringify({ secretKey: upper })],
      [
        'with-pub.txt',
        `Secret key: ${nip19.nsecEncode(secret)}\nPublic key: ${getPublicKey(secret)}\n`,
      ],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, content);
      expect(bytesToHex(await readImportedKey(path)), name).toBe(bytesToHex(secret));
    }
  });
});

describe('round 4: kept settings, import refusals, new stores, gates', () => {
  it('D1: a re-run with one flag keeps every other setting, the private part and the connector import choice', async () => {
    const setup = await harness();
    const dir = await tempDir();
    const instructions = join(dir, 'instructions.txt');
    await writeFile(instructions, 'Never promise dates.');
    await setup.run(
      initInvocation({
        language: 'de',
        displayName: 'Ava',
        greeting: 'Hallo',
        contact: 'https://shop.example/kontakt',
        instructionsFile: instructions,
        source: 'connector',
        platform: 'shopify',
        shopUrl: ORIGIN,
      }),
      INIT_ARGS,
    );
    const secret = await ownerSecret(setup);
    // What the CLI cannot set but must keep: link origins and notes, signed in the admin.
    setup.fake.stored.push({
      event: finalizeEvent(
        askr.buildConfigEvent(
          {
            assistant: setup.fake.assistant,
            origins: [ORIGIN],
            linkOrigins: ['https://cdn.example'],
            name: 'Example Shop',
            language: 'de',
            currency: 'USD',
            displayName: 'Ava',
            greeting: 'Hallo',
            contact: 'https://shop.example/kontakt',
            source: { kind: 'connector', platform: 'shopify', shopUrl: ORIGIN },
            catalogKey: setup.fake.catalogKey,
            private: { voice: '', instructions: 'Never promise dates.', notes: 'VIP list' },
            createdAt: nowSecs() + 5,
          },
          secret,
        ),
        secret,
      ),
      published: false,
      stopped: false,
    });
    if (setup.fake.connector !== null) {
      setup.fake.connector.importPolicies = false;
    }
    const voice = join(dir, 'voice.txt');
    await writeFile(voice, 'Warm.');
    const outcome = await setup.run({ command: 'init', options: { voiceFile: voice } }, ['init']);
    expect(outcome.exitCode).toBe(0);
    const latest = postedEvents(setup.fake.calls).at(-1);
    const config = latest === undefined ? undefined : askr.parseConfig(latest);
    expect(config).toMatchObject({
      name: 'Example Shop',
      origins: [ORIGIN],
      linkOrigins: ['https://cdn.example'],
      language: 'de',
      displayName: 'Ava',
      greeting: 'Hallo',
      contact: 'https://shop.example/kontakt',
      source: { kind: 'connector', platform: 'shopify', shopUrl: ORIGIN },
    });
    expect(
      config === undefined
        ? undefined
        : askr.decryptPrivateConfig(config, setup.fake.assistantSecret),
    ).toEqual({ voice: 'Warm.', instructions: 'Never promise dates.', notes: 'VIP list' });
    expect(setup.fake.routeCalls('PUT /v1/admin/connector').at(-1)?.body).toEqual({
      platform: 'shopify',
      url: ORIGIN,
      importPolicies: false,
    });
  });

  it('D2: the import check maps 5xx, 429 and moved to their own codes, and saves nothing', async () => {
    const cases: Array<[Response, number, string]> = [
      [json({ error: 'unavailable' }, 503), 4, 'unavailable'],
      [json({ error: 'rate_limited' }, 429), 4, 'rate_limited'],
      [json({ error: 'moved' }, 409), 3, 'moved_store'],
    ];
    for (const [answer, exitCode, code] of cases) {
      const setup = await harness();
      const secret = generateSecretKey();
      const path = join(await tempDir(), 'key.txt');
      await writeFile(path, nip19.nsecEncode(secret));
      setup.fake.on('GET /v1/admin/store', () => answer.clone());
      const outcome = await setup.run(initInvocation({ ownerKeyFile: path }), INIT_ARGS);
      expect(outcome.exitCode, code).toBe(exitCode);
      expect(outcome.output, code).toMatchObject({ error: { code } });
      expect(await readOwnerKey(setup.home, 'default'), code).toBeUndefined();
      if (code === 'moved_store') {
        expect(JSON.stringify(outcome.output)).toContain('now lives there');
      }
    }
  });

  it('D2: a config whose private part cannot be read is refused and nothing is signed', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const secret = await ownerSecret(setup);
    const template = askr.buildConfigEvent(
      {
        assistant: setup.fake.assistant,
        origins: [ORIGIN],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'admin' },
        catalogKey: setup.fake.catalogKey,
        createdAt: nowSecs() + 5,
      },
      secret,
    );
    setup.fake.stored.push({
      event: finalizeEvent({ ...template, content: 'not-a-sealed-part' }, secret),
      published: false,
      stopped: false,
    });
    const before = postedEvents(setup.fake.calls).length;
    const outcome = await setup.run(initInvocation({ greeting: 'Hi' }), INIT_ARGS);
    expect(outcome).toMatchObject({
      exitCode: 3,
      output: { error: { code: 'config_unreadable' } },
    });
    expect(postedEvents(setup.fake.calls)).toHaveLength(before);
  });

  it('S4: a certain new store without --name or --origin fails before any call or key', async () => {
    for (const options of [{ name: 'Shop' }, { origin: [ORIGIN] }]) {
      const setup = await harness();
      const outcome = await setup.run({ command: 'init', options }, ['init']);
      expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'missing_flag' } } });
      expect(setup.fake.calls).toHaveLength(0);
      expect(await readOwnerKey(setup.home, 'default')).toBeUndefined();
    }
  });

  it('S6: a policy on a store whose policy key is not server K is wrong_source, exit 3, nothing sent', async () => {
    const setup = await activeStore();
    const secret = await ownerSecret(setup);
    const event = configBy(secret, setup, {
      policyKey: getPublicKey(generateSecretKey()),
      createdAt: nowSecs() + 5,
    });
    setup.fake.relay.push(event);
    const file = join(await tempDir(), 'faq.md');
    await writeFile(file, 'Questions.');
    const outcome = await setup.run(
      { command: 'policy', options: { slug: 'faq', title: 'FAQ', file } },
      ['policy'],
    );
    expect(outcome).toMatchObject({ exitCode: 3, output: { error: { code: 'wrong_source' } } });
    expect(setup.fake.routeCalls('PUT /v1/admin/policies/faq')).toHaveLength(0);
  });

  it('M31: the connector on an active store without a tier is inactive, as the server answers, with no preview', async () => {
    const setup = await activeStore({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN });
    setup.fake.tier = null;
    const outcome = await setup.run({ command: 'connector' }, ['connector']);
    expect(outcome).toMatchObject({ exitCode: 5, output: { error: { code: 'inactive' } } });
    expect(setup.fake.routeCalls('POST /v1/admin/connector/preview')).toHaveLength(0);
  });
});

describe('round 5: flag files never carry an owner key', () => {
  /** The key file itself, a symlink to it, and copies of the key in hex (upper case) and as an nsec. */
  async function keyCarriers(setup: Harness): Promise<string[]> {
    const keyFile = keyFileOf(setup.home, 'default');
    const secret = await ownerSecret(setup);
    const dir = await tempDir();
    const linked = join(dir, 'linked.md');
    await symlink(keyFile, linked);
    const hex = join(dir, 'hex.md');
    await writeFile(hex, `Our terms.\nkey ${bytesToHex(secret).toUpperCase()}\n`);
    const nsec = join(dir, 'nsec.md');
    await writeFile(nsec, `Our terms. ${nip19.nsecEncode(secret)}`);
    const upperNsec = join(dir, 'upper-nsec.md');
    await writeFile(upperNsec, `Our terms. ${nip19.nsecEncode(secret).toUpperCase()}`);
    // Anything inside the key directory, key or not, is refused by its path.
    const inKeyDir = join(keyDirOf(setup.home), 'notes.md');
    await writeFile(inKeyDir, 'Not a key, but kept beside them.');
    return [keyFile, linked, hex, nsec, upperNsec, inKeyDir];
  }

  function refused(
    outcome: { exitCode: number; output: Record<string, unknown> },
    label: string,
  ): void {
    expect(outcome.exitCode, label).toBe(2);
    expect(outcome.output, label).toMatchObject({ error: { code: 'secret_in_file' } });
    expect(JSON.stringify(outcome.output), label).not.toContain('secretKey');
  }

  it('askr policy --file', async () => {
    const setup = await activeStore();
    for (const file of await keyCarriers(setup)) {
      const outcome = await setup.run(
        { command: 'policy', options: { slug: 'faq', title: 'FAQ', file } },
        ['policy'],
      );
      refused(outcome, file);
    }
    expect(setup.fake.routeCalls('PUT /v1/admin/policies/faq')).toHaveLength(0);
  });

  it('askr init --voice-file and --instructions-file', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const before = setup.fake.calls.length;
    for (const file of await keyCarriers(setup)) {
      refused(await setup.run({ command: 'init', options: { voiceFile: file } }, ['init']), file);
      refused(
        await setup.run({ command: 'init', options: { instructionsFile: file } }, ['init']),
        file,
      );
    }
    expect(setup.fake.calls).toHaveLength(before);
  });

  it('an imported key is kept out of the voice and instructions files too', async () => {
    for (const flag of ['voiceFile', 'instructionsFile'] as const) {
      const setup = await harness();
      const secret = generateSecretKey();
      setup.fake.owner = getPublicKey(secret);
      const dir = await tempDir();
      const keyPath = join(dir, 'key.txt');
      await writeFile(keyPath, nip19.nsecEncode(secret));
      const carrier = join(dir, 'text.txt');
      await writeFile(carrier, `Be kind. ${bytesToHex(secret)}`);
      const outcome = await setup.run(
        initInvocation({ ownerKeyFile: keyPath, [flag]: carrier }),
        INIT_ARGS,
      );
      refused(outcome, `imported ${flag}`);
      expect(setup.fake.calls).toHaveLength(0);
    }
  });

  it('askr products --file', async () => {
    const setup = await activeStore();
    const secret = await ownerSecret(setup);
    const dir = await tempDir();
    const inJson = join(dir, 'products.json');
    await writeFile(inJson, JSON.stringify([product('a', { description: bytesToHex(secret) })]));
    for (const file of [keyFileOf(setup.home, 'default'), inJson]) {
      refused(await setup.run({ command: 'products', options: { file } }, ['products']), file);
    }
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);
  });

  it('M19: an admin-source re-run with no connector sends no DELETE', async () => {
    const setup = await harness();
    await setup.run(initInvocation({ source: 'admin' }), INIT_ARGS);
    await setup.run({ command: 'init', options: { source: 'admin' } }, ['init']);
    expect(setup.fake.routeCalls('DELETE /v1/admin/connector')).toHaveLength(0);
  });
});
