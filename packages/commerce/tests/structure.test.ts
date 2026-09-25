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
/** The nostr-tools root pulls in the relay pool: types only, never code (spec 9.4). */
const TYPE_ONLY_ALLOWED = [/^nostr-tools$/];
const IMPORT_RE =
  /(?:^|\n)\s*((?:import|export)\b[^'"]*?)from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function isTypeOnly(statement: string | undefined): boolean {
  return statement !== undefined && /^(import|export)\s+type\b/.test(statement);
}

function isAllowed(specifier: string, statement: string | undefined): boolean {
  return (
    ALLOWED.some((pattern) => pattern.test(specifier)) ||
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
        if (!isAllowed(specifier, match[1])) {
          offenders.push(`${relative(SRC, file)}: ${specifier}`);
        }
      }
    }
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
