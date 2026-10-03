/**
 * The CLI end to end on scratch homes, for orderings no helper can pin: what
 * runs before the passphrase is read, and what a failing command leaves behind.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configTemplate } from '../src/config';
import { PAYOUT } from './fixtures';

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

describe('the merchant CLI', () => {
  it('setup on an encrypted home fails on the passphrase before any relay is tried', () => {
    const home = scratchDir();
    expect(cli(['init', '--home', home], { ELISYM_MERCHANT_PASSPHRASE: PASSPHRASE }).code).toBe(0);
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    // A relay that refuses at once: reaching it would fail with a relay error instead.
    config.inboxRelays = ['ws://localhost:9'];
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    const run = cli(['setup', '--home', home]);
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/encrypted owner key/);
    expect(run.output).not.toMatch(/inbox relays/);
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

  it('init on a plain home says so', () => {
    const home = scratchDir();
    const run = cli(['init', '--home', home]);
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/keys {4}plain/);
    expect(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).store).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
