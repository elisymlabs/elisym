/**
 * The fee wiring of the CLI, end to end: `setup`, `check` and `run` as a
 * merchant runs them, against the in-memory relay and RPC of
 * `harness/relay-preload.ts` (no network).
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrderMessage, deriveOrderPaymentReference, wrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { recordTreasuryRead } from '../src/fee';
import { PRE_FEE_LEDGER_VERSION, emptyLedger } from '../src/ledger';
import { publishTerms } from '../src/terms';
import { PAYOUT, TREASURY, USDC_DEVNET_CAIP19, signatureOf } from './fixtures';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./harness/relay-preload.ts', import.meta.url));
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1zcqDFVGPZXAh';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PATHUSD_MODERATO = 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000';
const TEMPO_PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
/** The config RPC the preload answers (`FEE_RPC_HOST` there; importing it would run the preload here). */
const FEE_RPC_HOST = 'fee-rpc.harness';
const TEMPO_RPC_HOST = 'tempo-rpc.harness';
const SOLANA_RPC_HOST = 'solana-rpc.harness';
const PRODUCT_D = 'my-product';
const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';
const NO_PROFILE_FEE = /store profile the relays serve does not declare protocol-fee support/;

interface Harness {
  dir: string;
  env: Record<string, string>;
}

function harness(
  options: {
    seed?: NostrEvent[];
    rejectKinds?: number[];
    genesis?: string;
    /** The config account the config RPC serves, from its `configFrom`-th read on (default the first). */
    config?: { treasury: string; feeBps: number };
    configFrom?: number;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'merchant-harness-'));
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(options.seed ?? []));
  return {
    dir,
    env: {
      HARNESS_DIR: dir,
      HARNESS_REJECT_KINDS: (options.rejectKinds ?? []).join(','),
      ...(options.genesis === undefined ? {} : { HARNESS_GENESIS: options.genesis }),
      ...(options.config === undefined ? {} : { HARNESS_CONFIG: JSON.stringify(options.config) }),
      ...(options.configFrom === undefined
        ? {}
        : { HARNESS_CONFIG_FROM: String(options.configFrom) }),
    },
  };
}

function records<T>(run: Harness, file: string): T[] {
  const path = join(run.dir, file);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

function published(run: Harness): NostrEvent[] {
  return records<{ event: NostrEvent }>(run, 'published.jsonl').map((entry) => entry.event);
}

function fetchedHosts(run: Harness): string[] {
  return records<{ host: string }>(run, 'fetches.jsonl').map((entry) => entry.host);
}

function subscribedKinds(run: Harness): number[] {
  return records<{ filters: { kinds?: number[] }[] }>(run, 'reqs.jsonl').flatMap((entry) =>
    entry.filters.flatMap((filter) => filter.kinds ?? []),
  );
}

function childEnv(run: Harness): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...run.env };
}

/** One command to its end, under the harness. */
function command(home: string, args: string[], run: Harness) {
  const result = spawnSync('bun', ['--preload', PRELOAD, CLI, ...args, '--home', home], {
    encoding: 'utf8',
    env: childEnv(run),
    timeout: 25_000,
  });
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

/** `run` under the harness, in the background: its output so far, and its exit. */
function startRun(home: string, run: Harness) {
  const child = spawn('bun', ['--preload', PRELOAD, CLI, 'run', '--home', home], {
    env: childEnv(run),
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  return { output: () => output, exited };
}

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

interface Keys {
  store: string;
  storePubkey: string;
}

function keysOf(home: string): Keys {
  return JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')) as Keys;
}

/** An initialised home with its product edited and `config` written over the template. */
function home(config: Record<string, unknown>, product = '10'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'merchant-cli-fee-')), 'home');
  const init = spawnSync('bun', [CLI, 'init', '--home', path], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
  });
  expect(init.status).toBe(0);
  mkdirSync(join(path, 'products', PRODUCT_D), { recursive: true });
  writeFileSync(
    join(path, 'products', PRODUCT_D, 'PRODUCT.md'),
    `---\ntitle: Deposit ${product} USD\npriceUsd: "${product}"\n---\n\nAdds ${product} USD to your account.\n`,
  );
  writeFileSync(
    join(path, 'config.json'),
    JSON.stringify({
      name: 'Shop',
      network: 'devnet',
      inboxRelays: ['wss://inbox.harness'],
      ...config,
    }),
  );
  return path;
}

/** A Solana store whose fee config RPC is the harness's. */
function solanaHome(): string {
  return home({
    rpcUrl: `https://${SOLANA_RPC_HOST}`,
    feeConfigRpcUrl: `https://${FEE_RPC_HOST}`,
    payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
  });
}

function writeLedger(path: string, state: unknown): void {
  writeFileSync(join(path, 'ledger.json'), JSON.stringify(state));
}

interface LedgerOnDisk {
  version: unknown;
  orders: Record<string, { reportedTxs: string[] }>;
  treasuries?: Record<string, { latest?: { solana?: string } }>;
}

function ledgerOf(path: string): LedgerOnDisk {
  return JSON.parse(readFileSync(join(path, 'ledger.json'), 'utf8')) as LedgerOnDisk;
}

function profileOf(events: NostrEvent[], storePubkey: string): NostrEvent | undefined {
  return events.find((event) => event.kind === 0 && event.pubkey === storePubkey);
}

function hasFeeTag(event: NostrEvent | undefined): boolean {
  return event?.tags.some((tag) => tag[0] === 'fee' && tag[1] === '1') === true;
}

/** The store's own profile without the fee tag, as a store set up before fee support left it. */
function taglessProfile(path: string): NostrEvent {
  return finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: [],
      content: JSON.stringify({ name: 'Shop' }),
    },
    hexToBytes(keysOf(path).store),
  );
}

describe('setup declares fee support only with treasuries it has read', () => {
  it('with the config RPC down and none persisted, the profile goes out WITHOUT the fee tag', () => {
    const path = solanaHome();
    const run = harness();
    const result = command(path, ['setup'], run);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/WITHOUT protocol-fee support/);
    const profile = profileOf(published(run), keysOf(path).storePubkey);
    expect(profile).toBeDefined();
    expect(hasFeeTag(profile)).toBe(false);
  });

  it('with the config RPC down and treasuries persisted, the profile carries the fee tag', () => {
    const path = solanaHome();
    const state = emptyLedger();
    recordTreasuryRead(
      state,
      'devnet',
      { treasury: TREASURY, evmTreasury: undefined },
      Math.floor(Date.now() / 1000) - 60,
    );
    writeLedger(path, state);
    const run = harness();
    const result = command(path, ['setup'], run);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/protocol-fee support declared/);
    expect(hasFeeTag(profileOf(published(run), keysOf(path).storePubkey))).toBe(true);
  });

  it('a payout list no relay takes beside a profile they do: the ledger on disk is v4, with the treasuries read', () => {
    const path = solanaHome();
    const { treasuries: _treasuries, unresolvedPayments: _unresolved, ...v3 } = emptyLedger();
    writeLedger(path, { ...v3, version: PRE_FEE_LEDGER_VERSION });
    const run = harness({
      rejectKinds: [10133],
      genesis: DEVNET_GENESIS,
      config: { treasury: TREASURY, feeBps: 0 },
    });
    const result = command(path, ['setup'], run);
    // The payout list reached no default relay: setup fails after publishing the rest.
    expect(result.code).not.toBe(0);
    const events = published(run);
    expect(profileOf(events, keysOf(path).storePubkey)).toBeDefined();
    expect(events.some((event) => event.kind === 10133)).toBe(false);
    expect(ledgerOf(path).version).toBe(4);
    // The treasuries the declaration rests on were saved before anything was published.
    expect(ledgerOf(path).treasuries?.devnet?.latest?.solana).toBe(TREASURY);
  });
});

describe('setup saves the treasuries it read before it contacts any relay', () => {
  it('inbox relays that take no gift wrap stop setup before it publishes: the treasuries are on disk', () => {
    const path = solanaHome();
    const run = harness({
      rejectKinds: [1059],
      genesis: DEVNET_GENESIS,
      config: { treasury: TREASURY, feeBps: 0 },
    });
    const result = command(path, ['setup'], run);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/do not take and serve gift wraps/);
    expect(profileOf(published(run), keysOf(path).storePubkey)).toBeUndefined();
    expect(ledgerOf(path).treasuries?.devnet?.latest?.solana).toBe(TREASURY);
  });
});

describe('run reads the treasuries again every sweep', () => {
  it('a config RPC that fails at start and answers later: the first sweep records its treasury', async () => {
    const path = solanaHome();
    // The first config read (at start) gets an error; the next one, the first sweep's, the account.
    const run = harness({
      genesis: DEVNET_GENESIS,
      config: { treasury: TREASURY, feeBps: 0 },
      configFrom: 2,
    });
    const node = startRun(path, run);
    expect(await until(() => /listening on/.test(node.output()))).toBe(true);
    expect(node.output()).toMatch(/the elisym fee config could not be read/);
    expect(await until(() => ledgerOf(path).treasuries?.devnet?.latest?.solana === TREASURY)).toBe(
      true,
    );
  });
});

/** A home whose ledger holds one open order of the product, keyed `<buyer>:<ORDER_ID>`. */
function homeWithOrder(
  feeUnresolved: Record<string, number> | undefined,
  closedWith?: { tx: string; at: number; otherTx?: string },
): { path: string; key: string } {
  const path = home({
    rpcUrl: `https://${SOLANA_RPC_HOST}`,
    payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
    inboxRelays: ['wss://inbox-a.harness', 'wss://inbox-b.harness'],
  });
  const { storePubkey } = keysOf(path);
  const buyerPubkey = getPublicKey(generateSecretKey());
  const key = `${buyerPubkey}:${ORDER_ID}`;
  const now = Math.floor(Date.now() / 1000);
  const state = emptyLedger();
  if (closedWith === undefined) {
    state.orders[key] = {
      key,
      buyerPubkey,
      orderId: ORDER_ID,
      rumorId: 'r'.repeat(64),
      createdAt: now - 600,
      reference: deriveOrderPaymentReference({ storePubkey, buyerPubkey, orderId: ORDER_ID })
        .solana,
      product: `30402:${storePubkey}:${PRODUCT_D}`,
      reportedTxs: [],
      ...(feeUnresolved === undefined ? {} : { feeUnresolved }),
    };
  } else {
    state.closedOrders = { [key]: true };
    state.unresolvedPayments = [{ key, tx: closedWith.tx, at: closedWith.at }];
    if (closedWith.otherTx !== undefined) {
      // Another closed order's unresolved payment, kept beside this one's.
      const otherKey = `${getPublicKey(generateSecretKey())}:${ORDER_ID}`;
      state.closedOrders[otherKey] = true;
      state.unresolvedPayments.unshift({
        key: otherKey,
        tx: closedWith.otherTx,
        at: closedWith.at,
      });
    }
  }
  writeLedger(path, state);
  return { path, key };
}

describe('a hand answer tells the payments left unresolved', () => {
  const unresolvedLine = (tx: string) =>
    new RegExp(`fee +unresolved: ${tx} \\(the owner decides on these\\)`);

  it('complete on an open order names its unresolved payment', () => {
    const tx = signatureOf(3);
    const { path, key } = homeWithOrder({ [tx]: Math.floor(Date.now() / 1000) - 60 });
    const result = command(path, ['complete', key, '--yes'], harness());
    expect(result.output).toMatch(unresolvedLine(tx));
  });

  it('refund on an order closed by the window names the unresolved payment it kept', () => {
    const tx = signatureOf(4);
    const otherTx = signatureOf(6);
    const { path, key } = homeWithOrder(undefined, {
      tx,
      at: Math.floor(Date.now() / 1000) - 4 * 86_400,
      otherTx,
    });
    const result = command(
      path,
      ['refund', key, '--tx', signatureOf(5), '--amount', '1000000', '--yes'],
      harness(),
    );
    expect(result.output).toMatch(unresolvedLine(tx));
    // Only the order's own: another closed order's unresolved payment is not printed.
    expect(result.output).not.toContain(otherTx);
  });

  it('an order with nothing unresolved prints no such line', () => {
    const { path, key } = homeWithOrder(undefined);
    const result = command(path, ['complete', key, '--yes'], harness());
    expect(result.output).toMatch(/order +/);
    expect(result.output).not.toMatch(/unresolved:/);
  });
});

describe('a config RPC of another cluster', () => {
  it('check refuses it', () => {
    const path = solanaHome();
    const run = harness({ genesis: MAINNET_GENESIS });
    const result = command(path, ['check'], run);
    expect(result.output).toMatch(/does not serve Solana devnet/);
    expect(result.code).toBe(1);
    // The same home with the right cluster passes: the refusal is the cluster's.
    expect(command(path, ['check'], harness({ genesis: DEVNET_GENESIS })).code).toBe(0);
  });

  it('run refuses it before the listener starts', async () => {
    const path = solanaHome();
    const run = harness({ genesis: MAINNET_GENESIS });
    const node = startRun(path, run);
    const code = await Promise.race([
      node.exited,
      new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), 20_000)),
    ]);
    expect(code).toBe(1);
    expect(node.output()).toMatch(/does not serve Solana devnet/);
    // The listener never started: no inbox subscription (kind 1059), no listening log.
    expect(node.output()).not.toMatch(/listening on/);
    expect(subscribedKinds(run)).not.toContain(1059);
  });
});

describe('the profile warning', () => {
  it('check warns about a served profile without the fee tag', () => {
    const path = solanaHome();
    const run = harness({ seed: [taglessProfile(path)] });
    const result = command(path, ['check'], run);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(NO_PROFILE_FEE);
  });

  it('run warns about a served profile without the fee tag', async () => {
    const path = solanaHome();
    const run = harness({ seed: [taglessProfile(path)] });
    const node = startRun(path, run);
    expect(await until(() => /listening on/.test(node.output()))).toBe(true);
    expect(node.output()).toMatch(NO_PROFILE_FEE);
  });

  it('neither warns when no profile is served', async () => {
    const path = solanaHome();
    expect(command(path, ['check'], harness()).output).not.toMatch(NO_PROFILE_FEE);
    const node = startRun(path, harness());
    expect(await until(() => /listening on/.test(node.output()))).toBe(true);
    expect(node.output()).not.toMatch(NO_PROFILE_FEE);
  });
});

/** A gift-wrapped receipt from `buyer` for the order. */
function receiptWrap(
  buyerSecretKey: Uint8Array,
  storePubkey: string,
  payment: { medium: string; reference: string; tx: string },
): NostrEvent {
  return wrapOrderMessage(
    buildOrderMessage(
      { type: 'receipt', storePubkey, orderId: ORDER_ID, payment },
      Math.floor(Date.now() / 1000),
    ),
    buyerSecretKey,
    storePubkey,
  ).recipientWrap;
}

describe('a Tempo-only store with a fee config RPC', () => {
  it('takes no Solana receipt and runs no Solana catch-up', async () => {
    const path = home({
      feeConfigRpcUrl: `https://${FEE_RPC_HOST}`,
      tempo: { network: 'moderato', rpcUrl: `https://${TEMPO_RPC_HOST}` },
      payouts: [{ caip19: PATHUSD_MODERATO, address: TEMPO_PAYOUT }],
    });
    const { storePubkey } = keysOf(path);
    const now = Math.floor(Date.now() / 1000);
    const buyerSecretKey = generateSecretKey();
    const buyerPubkey = getPublicKey(buyerSecretKey);
    const reference = deriveOrderPaymentReference({ storePubkey, buyerPubkey, orderId: ORDER_ID });
    // An open order of the product, which offered USDC on Solana until lately:
    // a Solana catch-up would check its reported signature.
    const state = emptyLedger();
    state.terms = publishTerms(
      [],
      { d: PRODUCT_D, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '10000000' },
      now - 7200,
      now - 7200,
    );
    state.terms = publishTerms(
      state.terms,
      { d: PRODUCT_D, caip19: PATHUSD_MODERATO, payout: TEMPO_PAYOUT, amount: '10000000' },
      now - 7200,
      now - 7200,
    );
    const key = `${buyerPubkey}:${ORDER_ID}`;
    state.orders[key] = {
      key,
      buyerPubkey,
      orderId: ORDER_ID,
      rumorId: 'r'.repeat(64),
      createdAt: now - 600,
      reference: reference.solana,
      product: `30402:${storePubkey}:${PRODUCT_D}`,
      reportedTxs: [signatureOf(1)],
    };
    writeLedger(path, state);
    const solanaTx = signatureOf(2);
    const tempoTx = `0x${'ab'.repeat(32)}`;
    // Read in this order: the Tempo receipt, taken, marks that the Solana one was handled.
    const run = harness({
      genesis: DEVNET_GENESIS,
      seed: [
        receiptWrap(buyerSecretKey, storePubkey, {
          medium: 'solana-devnet',
          reference: reference.solana,
          tx: solanaTx,
        }),
        receiptWrap(buyerSecretKey, storePubkey, {
          medium: 'tempo-moderato',
          reference: reference.tempo,
          tx: tempoTx,
        }),
      ],
    });
    const node = startRun(path, run);
    expect(await until(() => new RegExp(`receipt ${key} ${tempoTx}:`).test(node.output()))).toBe(
      true,
    );
    const reported = ledgerOf(path).orders[key]?.reportedTxs;
    expect(reported).toContain(tempoTx);
    expect(reported).not.toContain(solanaTx);
    // Only the fee config RPC and the Tempo RPC were asked: never a Solana endpoint.
    const hosts = new Set(fetchedHosts(run));
    expect(hosts.has(TEMPO_RPC_HOST)).toBe(true);
    expect([...hosts].filter((host) => host !== FEE_RPC_HOST && host !== TEMPO_RPC_HOST)).toEqual(
      [],
    );
  });
});
