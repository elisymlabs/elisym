/**
 * `setup` on a store-only home, end to end against the in-memory relay of
 * `harness/relay-preload.ts`: the owner's events go out as signed elsewhere,
 * and an owner-side refusal leaves nothing published and a fixed marker.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIND_DELETION,
  buildPaytoEvent,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  storeAuthAddress,
} from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { OWNER_REFUSAL_EXIT_CODE } from '../src/owner-events';
import { PAYOUT, TREASURY, USDC_DEVNET_CAIP19 } from './fixtures';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./harness/relay-preload.ts', import.meta.url));
const PRODUCT_D = 'my-product';
const PAYOUTS: { caip19: string; address: string }[] = [
  { caip19: USDC_DEVNET_CAIP19, address: PAYOUT },
];

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

interface StoreOnly {
  home: string;
  ownerSecret: Uint8Array;
  ownerPubkey: string;
  storePubkey: string;
}

/** A store-only home, its product edited and its config written. */
function storeOnlyHome(extra: Record<string, unknown> = {}): StoreOnly {
  const ownerSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const home = join(mkdtempSync(join(tmpdir(), 'merchant-owner-events-')), 'home');
  const init = spawnSync('bun', [CLI, 'init', '--owner-pubkey', ownerPubkey, '--home', home], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
  });
  expect(init.status).toBe(0);
  mkdirSync(join(home, 'products', PRODUCT_D), { recursive: true });
  writeFileSync(
    join(home, 'products', PRODUCT_D, 'PRODUCT.md'),
    '---\ntitle: Deposit 10 USD\npriceUsd: "10"\n---\n\nAdds 10 USD to your account.\n',
  );
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'Shop',
      network: 'devnet',
      inboxRelays: ['wss://inbox.harness'],
      rpcUrl: 'https://solana-rpc.harness',
      feeConfigRpcUrl: 'https://fee-rpc.harness',
      payouts: PAYOUTS,
      ...extra,
    }),
  );
  const keys = JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')) as {
    storePubkey: string;
  };
  return { home, ownerSecret, ownerPubkey, storePubkey: keys.storePubkey };
}

function payoutList(store: StoreOnly, createdAt: number, payouts = PAYOUTS): NostrEvent {
  return finalizeEvent(
    buildPaytoEvent({ ownerPubkey: store.ownerPubkey, accept: payouts, createdAt }),
    store.ownerSecret,
  );
}

function auth(store: StoreOnly, createdAt: number): NostrEvent {
  return finalizeEvent(
    buildStoreAuthEvent({
      storePubkey: store.storePubkey,
      mode: 'hosted',
      operator: 'cloud.harness',
      createdAt,
    }),
    store.ownerSecret,
  );
}

function writeOwnerEvents(store: StoreOnly, events: { payoutList: NostrEvent; auth: NostrEvent }) {
  writeFileSync(join(store.home, 'owner-events.json'), JSON.stringify(events));
}

function harness(seed: NostrEvent[] = []): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'merchant-harness-'));
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed));
  return { dir, env: { HARNESS_DIR: dir } };
}

function setup(store: StoreOnly, run: { env: Record<string, string> }) {
  const result = spawnSync('bun', ['--preload', PRELOAD, CLI, 'setup', '--home', store.home], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...run.env },
    timeout: 25_000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The kinds a store publishes; a gift wrap (1059) is only the inbox relay probe. */
const STORE_KINDS = new Set([0, 10050, 10133, 30402, 30490]);

function storeEventsPublished(run: { dir: string }): NostrEvent[] {
  return published(run).filter((event) => STORE_KINDS.has(event.kind));
}

function published(run: { dir: string }): NostrEvent[] {
  const path = join(run.dir, 'published.jsonl');
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { event: NostrEvent }).event);
}

describe('setup on a store-only home', () => {
  it('publishes the owner events as signed, and a profile naming the owner', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    const events = { payoutList: payoutList(store, signedAt), auth: auth(store, signedAt) };
    writeOwnerEvents(store, events);
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(0);
    const ids = published(run).map((event) => event.id);
    expect(ids).toContain(events.payoutList.id);
    expect(ids).toContain(events.auth.id);
    const profile = published(run).find(
      (event) => event.kind === 0 && event.pubkey === store.storePubkey,
    );
    expect(profile?.tags.some((tag) => tag[1] === store.ownerPubkey) ?? false).toBe(true);
    const ledger = JSON.parse(readFileSync(join(store.home, 'ledger.json'), 'utf8')) as {
      payto?: { createdAt: number };
    };
    expect(ledger.payto?.createdAt).toBe(signedAt);
    // Again, unchanged: the same events, accepted as the relays serve them.
    const again = setup(store, run);
    expect(again.code).toBe(0);
  });

  it('a payout list that is not config.json is refused with the owner marker, before anything', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt, [{ caip19: USDC_DEVNET_CAIP19, address: TREASURY }]),
      auth: auth(store, signedAt),
    });
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(result.output).toMatch(/^refused owner-resign: /m);
    expect(storeEventsPublished(run)).toEqual([]);
    expect(existsSync(join(store.home, 'ledger.json'))).toBe(false);
  });

  it('a newer owner list on the relays is refused with the owner marker, nothing published', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const run = harness([payoutList(store, signedAt + 30)]);
    const result = setup(store, run);
    expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(result.output).toMatch(/^refused owner-resign: .*newer payout list/m);
    expect(storeEventsPublished(run)).toEqual([]);
  });

  it('a revocation on the relays, by AUTH or by deletion, is refused as owner-revoked', () => {
    for (const revoking of ['auth', 'deletion'] as const) {
      const store = storeOnlyHome();
      const signedAt = nowSecs() - 60;
      writeOwnerEvents(store, {
        payoutList: payoutList(store, signedAt),
        auth: auth(store, signedAt),
      });
      const revocation =
        revoking === 'auth'
          ? finalizeEvent(buildStoreRevocationEvent(store.storePubkey, signedAt), store.ownerSecret)
          : finalizeEvent(
              {
                kind: KIND_DELETION,
                created_at: signedAt + 1,
                tags: [['a', storeAuthAddress(store.ownerPubkey, store.storePubkey)]],
                content: '',
              },
              store.ownerSecret,
            );
      const run = harness([revocation]);
      const result = setup(store, run);
      expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
      expect(result.output).toMatch(/^refused owner-revoked: /m);
      expect(storeEventsPublished(run)).toEqual([]);
    }
  });

  it('a revocation is reported before a newer payout list', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const revocation = finalizeEvent(
      buildStoreRevocationEvent(store.storePubkey, signedAt),
      store.ownerSecret,
    );
    const run = harness([payoutList(store, signedAt + 30), revocation]);
    const result = setup(store, run);
    expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(result.output).toMatch(/^refused owner-revoked: /m);
    expect(storeEventsPublished(run)).toEqual([]);
  });

  it('a newer, expired AUTH on the relays is refused: the console signs again', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 600;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const expiredNewer = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: store.storePubkey,
        mode: 'hosted',
        createdAt: signedAt + 60,
        expiresAt: signedAt + 120,
      }),
      store.ownerSecret,
    );
    const run = harness([expiredNewer]);
    const result = setup(store, run);
    expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(result.output).toMatch(/^refused owner-resign: .*newer store authorization/m);
    expect(storeEventsPublished(run)).toEqual([]);
  });

  it("a forged payout list on a relay is not the owner's newest", () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const forged: NostrEvent = {
      ...JSON.parse(JSON.stringify(payoutList(store, signedAt + 30))),
      created_at: signedAt + 86_400,
    };
    expect(setup(store, harness([forged])).code).toBe(0);
  });

  it('a revocation is reported before a newer expired AUTH', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 600;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const deletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: signedAt + 1,
        tags: [['a', storeAuthAddress(store.ownerPubkey, store.storePubkey)]],
        content: '',
      },
      store.ownerSecret,
    );
    const expiredNewer = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: store.storePubkey,
        mode: 'hosted',
        createdAt: signedAt + 2,
        expiresAt: signedAt + 3,
      }),
      store.ownerSecret,
    );
    const result = setup(store, harness([deletion, expiredNewer]));
    expect(result.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(result.output).toMatch(/^refused owner-revoked: /m);
  });

  it('a home with no owner-events.json fails plainly, not as an owner refusal', () => {
    const store = storeOnlyHome();
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^error: .*no owner-events.json/m);
    expect(existsSync(join(store.home, 'ledger.json'))).toBe(false);
  });

  it('writes no nostr.json: the domain names the owner from where its key lives', () => {
    const store = storeOnlyHome({ nip05: '_@shop.example' });
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const result = setup(store, harness());
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/nostr {3}not written: this home holds no owner key/);
    expect(existsSync(join(store.home, 'nostr.json'))).toBe(false);
  });

  it('a payout list dated past the host clock is the host, not the owner; a revocation still wins', () => {
    const store = storeOnlyHome();
    const ahead = nowSecs() + 3600;
    writeOwnerEvents(store, { payoutList: payoutList(store, ahead), auth: auth(store, ahead) });
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^error: .*clock/m);
    expect(storeEventsPublished(run)).toEqual([]);
    const revocation = finalizeEvent(
      buildStoreRevocationEvent(store.storePubkey, ahead),
      store.ownerSecret,
    );
    const revoked = setup(store, harness([revocation]));
    expect(revoked.code).toBe(OWNER_REFUSAL_EXIT_CODE);
    expect(revoked.output).toMatch(/^refused owner-revoked: /m);
  });

  it('an AUTH dated past the host clock is the host, like the payout list', () => {
    const store = storeOnlyHome();
    writeOwnerEvents(store, {
      payoutList: payoutList(store, nowSecs() - 60),
      auth: auth(store, nowSecs() + 3600),
    });
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^error: .*store authorization/m);
    expect(storeEventsPublished(run)).toEqual([]);
  });

  it('reads revocations from the inbox relays too', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    const run = harness();
    expect(setup(store, run).code).toBe(0);
    const reqs = readFileSync(join(run.dir, 'reqs.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { relay: string; filters: { '#a'?: string[] }[] });
    const deletionRelays = reqs
      .filter((entry) => entry.filters.some((filter) => filter['#a'] !== undefined))
      .map((entry) => entry.relay);
    expect(deletionRelays.some((relay) => relay.includes('inbox.harness'))).toBe(true);
    expect(deletionRelays.some((relay) => !relay.includes('inbox.harness'))).toBe(true);
  });
});

/** The home's product taken off sale. */
function stopSelling(store: StoreOnly): void {
  writeFileSync(
    join(store.home, 'products', PRODUCT_D, 'PRODUCT.md'),
    '---\ntitle: Deposit 10 USD\npriceUsd: "10"\nonSale: false\n---\n\nAdds 10 USD to your account.\n',
  );
}

function ledgerPayto(store: StoreOnly): { createdAt: number } | undefined {
  return (
    JSON.parse(readFileSync(join(store.home, 'ledger.json'), 'utf8')) as {
      payto?: { createdAt: number };
    }
  ).payto;
}

describe('a withdrawal in a store-only home', () => {
  it('needs no owner events and publishes none; a rerun with nothing changed succeeds', () => {
    const store = storeOnlyHome();
    const signedAt = nowSecs() - 60;
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    expect(setup(store, harness()).code).toBe(0);
    expect(ledgerPayto(store)?.createdAt).toBe(signedAt);
    stopSelling(store);
    // The owner's events gone: nothing the owner holds can block taking the store off sale.
    rmSync(join(store.home, 'owner-events.json'));
    const run = harness();
    const result = setup(store, run);
    expect(result.code).toBe(0);
    const kinds = storeEventsPublished(run).map((event) => event.kind);
    expect(kinds).toContain(30402);
    expect(kinds).toContain(0);
    expect(kinds).toContain(10050);
    expect(kinds).not.toContain(10133);
    expect(kinds).not.toContain(30490);
    // The payout side the ledger recorded stays as it was.
    expect(ledgerPayto(store)?.createdAt).toBe(signedAt);
    // Again, the relays serving what the withdrawal published: nothing to republish.
    const served = harness(published(run));
    const again = setup(store, served);
    expect(again.code).toBe(0);
    expect(storeEventsPublished(served).map((event) => event.kind)).not.toContain(30402);
    // The profile still goes out (in the same second it is the same event, so the log, not the store, shows it).
    expect(again.output).toMatch(/kind 0: accepted by [1-9]/);
    // Back on sale with the same signed events: the recorded payout list still holds.
    writeOwnerEvents(store, {
      payoutList: payoutList(store, signedAt),
      auth: auth(store, signedAt),
    });
    writeFileSync(
      join(store.home, 'products', PRODUCT_D, 'PRODUCT.md'),
      '---\ntitle: Deposit 10 USD\npriceUsd: "10"\n---\n\nAdds 10 USD to your account.\n',
    );
    const resumed = harness(published(run));
    expect(setup(store, resumed).code).toBe(0);
    expect(storeEventsPublished(resumed).map((event) => event.kind)).toContain(10133);
  });

  it('a store with one product still on sale is no withdrawal: it needs the owner events', () => {
    const store = storeOnlyHome();
    mkdirSync(join(store.home, 'products', 'stopped'), { recursive: true });
    writeFileSync(
      join(store.home, 'products', 'stopped', 'PRODUCT.md'),
      '---\ntitle: Old deposit\npriceUsd: "5"\nonSale: false\n---\n\nNo longer sold.\n',
    );
    const result = setup(store, harness());
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no owner-events.json/);
  });

  it('is not blocked by a revocation or a newer payout list on the relays', () => {
    const store = storeOnlyHome();
    stopSelling(store);
    const signedAt = nowSecs() - 60;
    const revocation = finalizeEvent(
      buildStoreRevocationEvent(store.storePubkey, signedAt + 1),
      store.ownerSecret,
    );
    const run = harness([revocation, payoutList(store, signedAt + 30)]);
    const result = setup(store, run);
    expect(result.code).toBe(0);
    const kinds = storeEventsPublished(run).map((event) => event.kind);
    expect(kinds).not.toContain(10133);
    expect(kinds).not.toContain(30490);
    expect(ledgerPayto(store)).toBeUndefined();
  });

  it('a home with an owner key still publishes its payout list when stopping', () => {
    const ownerSecret = generateSecretKey();
    const home = join(mkdtempSync(join(tmpdir(), 'merchant-owner-events-')), 'home');
    expect(
      spawnSync('bun', [CLI, 'init', '--home', home], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
      }).status,
    ).toBe(0);
    const store: StoreOnly = {
      home,
      ownerSecret,
      ownerPubkey: getPublicKey(ownerSecret),
      storePubkey: '',
    };
    mkdirSync(join(home, 'products', PRODUCT_D), { recursive: true });
    stopSelling(store);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        name: 'Shop',
        network: 'devnet',
        inboxRelays: ['wss://inbox.harness'],
        rpcUrl: 'https://solana-rpc.harness',
        feeConfigRpcUrl: 'https://fee-rpc.harness',
        payouts: PAYOUTS,
      }),
    );
    const run = harness();
    expect(setup(store, run).code).toBe(0);
    expect(storeEventsPublished(run).map((event) => event.kind)).toContain(10133);
  });
});
