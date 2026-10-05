/**
 * The CLI end to end on scratch homes, for orderings no helper can pin: what
 * runs before the passphrase is read, and what a failing command leaves behind.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configTemplate } from '../src/config';
import { emptyLedger, newWebhookEntry, webhookEventId } from '../src/ledger';
import { PAYOUT, T0, USDC_DEVNET_CAIP19 } from './fixtures';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PASSPHRASE = 'correct horse battery staple';

function cli(args: string[], env: Record<string, string> = {}, timeoutMs = 20_000) {
  const result = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env },
    timeout: timeoutMs,
  });
  // The child must have run to an exit code: a missing bun or a timeout never passes.
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function scratchDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'merchant-cli-')), 'home');
}

const WEBHOOK_SECRET = 's'.repeat(40);
const BUYER = 'b'.repeat(64);
const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';
const PAID_SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

/** An initialised home whose config names `webhookUrl` (local, so allowInsecure). */
function webhookHome(webhookUrl = 'http://127.0.0.1:9/hook'): string {
  const home = scratchDir();
  expect(cli(['init', '--home', home]).code).toBe(0);
  const config = configTemplate('devnet');
  config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
  // A relay that refuses at once: a command that reached it fails with a relay error.
  config.inboxRelays = ['ws://localhost:9'];
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ ...config, webhook: { url: webhookUrl, allowInsecure: true } }),
  );
  return home;
}

/** Give the scaffolded product a real delivery, as an operator does before setup. */
function editProduct(home: string): void {
  writeFileSync(
    join(home, 'products', 'my-product', 'PRODUCT.md'),
    '---\ntitle: My product\npriceUsd: "10"\ndelivery:\n  method: access\n  value: https://shop.example/x\n---\n\nWhat the buyer gets.\n',
  );
}

function storePubkeyOf(home: string): string {
  return (JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')) as { storePubkey: string })
    .storePubkey;
}

/** A ledger holding one paid order with a customer reference and a failed webhook. */
function writePaidLedger(home: string): string {
  const state = emptyLedger();
  const order = {
    key: `${BUYER}:${ORDER_ID}`,
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    rumorId: 'r'.repeat(64),
    createdAt: T0,
    reference: 'ref',
    product: `30402:${storePubkeyOf(home)}:my-product`,
    reportedTxs: [],
    customerRef: 'user-123',
    paid: {
      signature: PAID_SIG,
      amount: '1000000',
      blockTime: T0 + 60,
      caip19: USDC_DEVNET_CAIP19,
      medium: 'solana-devnet',
    },
  };
  state.orders[order.key] = {
    ...order,
    webhook: { ...newWebhookEntry(storePubkeyOf(home), order, T0), state: 'failed' },
  };
  writeFileSync(join(home, 'ledger.json'), JSON.stringify(state));
  return order.key;
}

/** Run the CLI without blocking this process, so a local receiver can answer it. */
function cliAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn('bun', [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

describe('the merchant CLI', () => {
  it('setup on an encrypted home fails on the passphrase before any relay is tried', () => {
    const home = scratchDir();
    expect(cli(['init', '--home', home], { ELISYM_MERCHANT_PASSPHRASE: PASSPHRASE }).code).toBe(0);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    // A relay that refuses at once: reaching it would fail with a relay error instead.
    config.inboxRelays = ['ws://localhost:9'];
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    editProduct(home);
    const run = cli(['setup', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/encrypted owner key/);
    expect(run.output).not.toMatch(/inbox relays/);
  });

  it('init scaffolds a product setup refuses until its delivery is real (M37), before any relay', () => {
    const home = scratchDir();
    const init = cli(['init', '--home', home]);
    expect(init.code).toBe(0);
    expect(existsSync(join(home, 'products', 'my-product', 'PRODUCT.md'))).toBe(true);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    config.inboxRelays = ['ws://localhost:9'];
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    const run = cli(['setup', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/still deliver the example link/);
    expect(run.output).not.toMatch(/inbox relays/);
  });

  it('refuses a home made by 0.7: a config naming its one product, or a version 1 or 2 ledger', () => {
    const home = scratchDir();
    expect(cli(['init', '--home', home]).code).toBe(0);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    config.inboxRelays = ['ws://localhost:9'];
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...config, product: { d: 'x' } }));
    const old = cli(['check', '--home', home]);
    expect(old.code).not.toBe(0);
    expect(old.output).toMatch(/create a new home with init/);
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    editProduct(home);
    writeFileSync(join(home, 'ledger.json'), JSON.stringify({ ...emptyLedger(), version: 2 }));
    const ledger = cli(['check', '--home', home]);
    expect(ledger.code).not.toBe(0);
    expect(ledger.output).toMatch(/create a new home with init/);
  });

  it('M19: run and check refuse a product with a history whose directory is gone, before any relay', () => {
    const home = scratchDir();
    expect(cli(['init', '--home', home]).code).toBe(0);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    config.inboxRelays = ['ws://localhost:9'];
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    editProduct(home);
    const state = emptyLedger();
    state.terms = [
      { terms: { d: 'gone', caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '1' }, from: T0 },
    ];
    writeFileSync(join(home, 'ledger.json'), JSON.stringify(state));
    for (const command of ['run', 'check', 'setup']) {
      const run = cli([command, '--home', home]);
      expect(run.code).not.toBe(0);
      expect(run.output).toMatch(
        /product gone has a history in this store: restore products\/gone/,
      );
      expect(run.output).not.toMatch(/inbox relays|relay /);
    }
  });

  it('takes --product for deliver only', () => {
    const home = scratchDir();
    const run = cli(['orders', '--product', 'x', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/--product is for deliver/);
  });

  it('a failing init leaves no half-made home', () => {
    const ownerOnly = scratchDir();
    const noPassphrase = cli(['init', '--owner-only', '--home', ownerOnly]);
    expect(noPassphrase.code).not.toBe(0);
    expect(noPassphrase.output).toMatch(/--owner-only encrypts/);
    expect(existsSync(ownerOnly)).toBe(false);
    const missingFile = scratchDir();
    const missing = cli(['init', '--home', missingFile], {
      ELISYM_MERCHANT_PASSPHRASE_FILE: join(tmpdir(), `missing-${Date.now()}`),
    });
    expect(missing.code).not.toBe(0);
    expect(missing.output).toMatch(/ENOENT|no such file/);
    expect(existsSync(missingFile)).toBe(false);
    const emptyFile = scratchDir();
    const empty = join(mkdtempSync(join(tmpdir(), 'merchant-cli-')), 'passphrase');
    writeFileSync(empty, '');
    const fromEmpty = cli(['init', '--home', emptyFile], {
      ELISYM_MERCHANT_PASSPHRASE_FILE: empty,
    });
    expect(fromEmpty.code).not.toBe(0);
    expect(fromEmpty.output).toMatch(/is empty/);
    expect(existsSync(emptyFile)).toBe(false);
  });

  it('encrypt-keys on a home that does not exist creates nothing', () => {
    const typo = scratchDir();
    const run = cli(['encrypt-keys', '--home', typo], { ELISYM_MERCHANT_PASSPHRASE: PASSPHRASE });
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/run init first/);
    expect(existsSync(typo)).toBe(false);
  });

  it('store-key off a terminal prints no key without --yes', () => {
    const home = scratchDir();
    expect(cli(['init', '--home', home]).code).toBe(0);
    const run = cli(['store-key', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/--yes/);
    expect(run.output).not.toMatch(/nsec1/);
    expect(cli(['store-key', '--yes', '--home', home]).output).toMatch(/nsec1/);
  });

  it('check on an owner-only home without the passphrase writes no nostr.json', () => {
    const home = scratchDir();
    expect(
      cli(['init', '--owner-only', '--home', home], { ELISYM_MERCHANT_PASSPHRASE: PASSPHRASE })
        .code,
    ).toBe(0);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    config.inboxRelays = ['ws://localhost:9'];
    config.nip05 = '_@example.com';
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    // check reads the public offer relays and the domain: each read is bounded
    // (about 10 s), so this call gets room for a slow network.
    const run = cli(['check', '--home', home], {}, 50_000);
    expect(run.output).toMatch(/nostr {3}not written/);
    expect(existsSync(join(home, 'nostr.json'))).toBe(false);
  }, 60_000);

  it('run with a webhook and no secret refuses before any relay or lock', () => {
    const home = webhookHome();
    const run = cli(['run', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/no secret is set/);
    expect(existsSync(join(home, 'run.lock'))).toBe(false);
    const short = cli(['run', '--home', home], { ELISYM_MERCHANT_WEBHOOK_SECRET: 'too short' });
    expect(short.code).not.toBe(0);
    expect(short.output).toMatch(/shorter than 32 bytes/);
    expect(short.output).not.toContain('too short');
  });

  it('webhook retry and resend refuse while a node holds the home', () => {
    const home = webhookHome();
    const key = writePaidLedger(home);
    writeFileSync(join(home, 'run.lock'), 'another-node');
    for (const kind of ['retry', 'resend']) {
      const run = cli(['webhook', kind, key, '--home', home], {
        ELISYM_MERCHANT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      });
      expect(run.code).not.toBe(0);
      expect(run.output).toMatch(/another merchant holds/);
    }
    // Nothing was rearmed.
    const ledger = JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8')) as ReturnType<
      typeof emptyLedger
    >;
    expect(ledger.orders[key]?.webhook?.state).toBe('failed');
  });

  it('orders prints the customer reference, the webhook state and the event id', () => {
    const home = webhookHome();
    const key = writePaidLedger(home);
    const run = cli(['orders', '--home', home]);
    expect(run.code).toBe(0);
    expect(run.output).toContain(
      `${key} product=my-product 1000000 ${PAID_SIG} ref=user-123 webhook=failed event=${webhookEventId(storePubkeyOf(home), key, PAID_SIG)}`,
    );
  });

  it('webhook test and retry send signed events a receiver can check', async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const home = webhookHome(`http://127.0.0.1:${port}/hook`);
      const env = { ELISYM_MERCHANT_WEBHOOK_SECRET: WEBHOOK_SECRET };
      const test = await cliAsync(['webhook', 'test', '--home', home], env);
      expect(test.code).toBe(0);
      const key = writePaidLedger(home);
      const retry = await cliAsync(['webhook', 'retry', key, '--home', home], env);
      expect(retry.output).toMatch(/sent \(200\)/);
      expect(retry.code).toBe(0);
      expect(received.map((request) => JSON.parse(request.body).event)).toEqual([
        'test',
        'order.paid',
      ]);
      for (const request of received) {
        const timestamp = String(request.headers['x-elisym-timestamp']);
        const mac = createHmac('sha256', WEBHOOK_SECRET)
          .update(`${timestamp}.${request.body}`)
          .digest('hex');
        expect(request.headers['x-elisym-signature']).toBe(`v1=${mac}`);
        expect(String(request.headers['user-agent'])).toMatch(
          /^elisym-merchant-node\/\d+\.\d+\.\d+$/,
        );
      }
      expect(JSON.parse(received[1]?.body ?? '{}')).toMatchObject({ customerRef: 'user-123' });
      const ledger = JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8')) as ReturnType<
        typeof emptyLedger
      >;
      expect(ledger.orders[key]?.webhook).toMatchObject({ state: 'sent', attempts: 1 });
      expect(existsSync(join(home, 'run.lock'))).toBe(false);
    } finally {
      server.close();
    }
  }, 60_000);

  it('init on a plain home says so', () => {
    const home = scratchDir();
    const run = cli(['init', '--home', home]);
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/keys {4}plain/);
    expect(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).store).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('admin takes --port, a real port, and only admin does', () => {
    const notAPort = cli(['admin', '--port', '0']);
    expect(notAPort.code).not.toBe(0);
    expect(notAPort.output).toMatch(/--port is a number from 1 to 65535/);
    expect(cli(['admin', '--port', '12ab']).output).toMatch(/--port is a number/);
    const elsewhere = cli(['orders', '--port', '5199', '--home', scratchDir()]);
    expect(elsewhere.code).not.toBe(0);
    expect(elsewhere.output).toMatch(/--port is for admin/);
  });

  it('the built admin serves its page on 127.0.0.1, reading no home', async () => {
    const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const child = spawn('node', [built, 'admin', '--port', String(port)], {
      env: { PATH: process.env.PATH ?? '', HOME: join(tmpdir(), `no-home-${Date.now()}`) },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.includes(`http://127.0.0.1:${port}/`)) {
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`admin exited with ${code}: ${output}`)));
      });
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="store-key"');
      const app = await fetch(`http://127.0.0.1:${port}/app.js`);
      expect(app.status).toBe(200);
      expect((await app.text()).length).toBeGreaterThan(1000);
    } finally {
      child.kill();
    }
  });
});
