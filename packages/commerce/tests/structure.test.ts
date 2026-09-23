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
  /^nostr-tools(\/(nip19|nip44|nip59))?$/,
  /^@noble\/curves\/(ed25519|secp256k1)\.js$/,
  /^@noble\/hashes\/sha3\.js$/,
  /^@scure\/base$/,
  /^zod$/,
];
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

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
        const specifier = match[1] ?? match[2] ?? '';
        if (!ALLOWED.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${relative(SRC, file)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
      expect(ALLOWED.some((pattern) => pattern.test(specifier))).toBe(false);
    }
  });
});
