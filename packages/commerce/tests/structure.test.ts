/**
 * The commerce package stands on the payment core and Nostr primitives only. It
 * never reaches into `@elisym/sdk` (the marketplace, skills, runtime, transport),
 * and it pulls in nothing Node-only, because the same code runs in the checkout
 * iframe. A new import has to be added here on purpose.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const ALLOWED = [
  /^\.\.?\//,
  /^@elisym\/pay-core$/,
  /^nostr-tools\/(pure|nip19|nip44|nip59)$/,
  /^@noble\/curves\/(ed25519|secp256k1)\.js$/,
  /^@noble\/hashes\/(sha2|sha3)\.js$/,
  /^@scure\/base$/,
  /^decimal\.js-light$/,
  /^zod$/,
];
/**
 * The buyer subpath (`@elisym/commerce/buyer`) talks to relays and to Solana:
 * it may also use the relay pool, the Solana kit and the token program. The
 * main entry never imports it, so a consumer that only verifies offers pulls
 * none of that in.
 */
const BUYER_ALLOWED = [
  /^nostr-tools\/(pool|utils)$/,
  /^@solana\/kit$/,
  /^@solana-program\/token$/,
  // EIP-1193 reads only: no EVM library comes with it.
  /^@elisym\/pay-core\/evm$/,
];
/** The nostr-tools root pulls in the relay pool: types only, never code (spec 9.4). */
const TYPE_ONLY_ALLOWED = [/^nostr-tools$/];
const IMPORT_RE =
  /(?:^|\n)\s*((?:import|export)\b[^'"]*?)from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function isTypeOnly(statement: string | undefined): boolean {
  return statement !== undefined && /^(import|export)\s+type\b/.test(statement);
}

function isAllowed(specifier: string, statement: string | undefined, buyer = false): boolean {
  return (
    ALLOWED.some((pattern) => pattern.test(specifier)) ||
    (buyer && BUYER_ALLOWED.some((pattern) => pattern.test(specifier))) ||
    (isTypeOnly(statement) && TYPE_ONLY_ALLOWED.some((pattern) => pattern.test(specifier)))
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('package boundary', () => {
  const files = sourceFiles(SRC);

  it('finds the sources it guards', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('imports only the payment core, Nostr primitives and its own modules', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const specifier = match[2] ?? match[3] ?? match[4] ?? '';
        const buyer = relative(SRC, file).startsWith(`buyer${'/'}`);
        if (!isAllowed(specifier, match[1], buyer)) {
          offenders.push(`${relative(SRC, file)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the main entry free of the buyer subpath', () => {
    const offenders = files
      .filter((file) => !relative(SRC, file).startsWith(`buyer${'/'}`))
      .filter((file) => /from\s*['"]\.\.?\/buyer/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('sees every import form: from, dynamic, and bare side-effect', () => {
    const source = [
      "import { a } from 'from-form';",
      "export * as b from 'export-form';",
      "const c = await import('dynamic-form');",
      "import 'side-effect-form';",
    ].join('\n');
    const found = [...source.matchAll(IMPORT_RE)].map((match) => match[2] ?? match[3] ?? match[4]);
    expect(found).toEqual(['from-form', 'export-form', 'dynamic-form', 'side-effect-form']);
  });

  it('the guard catches what it should', () => {
    const blocked = [
      '@elisym/sdk',
      '@elisym/sdk/node',
      'node:fs',
      'nostr-tools/pool',
      '@solana/kit',
    ];
    for (const specifier of blocked) {
      expect(isAllowed(specifier, 'import { x } ')).toBe(false);
    }
    // The nostr-tools root: types yes, code no.
    expect(isAllowed('nostr-tools', 'import type { NostrEvent } ')).toBe(true);
    expect(isAllowed('nostr-tools', 'import { SimplePool } ')).toBe(false);
  });
});
