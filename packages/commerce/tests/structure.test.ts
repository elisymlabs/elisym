/**
 * The commerce package stands on the payment core and Nostr primitives only. It
 * never reaches into `@elisym/sdk` (the marketplace, skills, runtime, transport),
 * and it pulls in nothing Node-only, because the same code runs in the checkout
 * iframe. A new import has to be added here on purpose.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const DIST = join(__dirname, '..', 'dist');
const WEBHOOK_DIR = join(SRC, 'webhook');
/**
 * The webhook subpath (`@elisym/commerce/webhook`) runs in any merchant backend:
 * it imports no package at all, only its own files and these import-free
 * protocol modules.
 */
const WEBHOOK_ALLOWED_PARENT = new Set([join(SRC, 'tags.ts'), join(SRC, 'constants.ts')]);
/** Node and DOM type names the webhook's public types must never mention. */
const WEBHOOK_DTS_FORBIDDEN_RE = /\b(Headers|Request|Response|Buffer|CryptoKey|NodeJS)\b/;
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

function isWebhookFile(file: string): boolean {
  return relative(SRC, file).startsWith(`webhook${'/'}`);
}

/** What a webhook file may import: its siblings, or the import-free protocol modules. */
function isWebhookImportAllowed(file: string, specifier: string): boolean {
  if (!/^\.\.?\//.test(specifier)) {
    return false;
  }
  const target = `${resolve(dirname(file), specifier)}.ts`;
  return isWebhookFile(target) || WEBHOOK_ALLOWED_PARENT.has(target);
}

function specifiersOf(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((match) => match[2] ?? match[3] ?? match[4] ?? '');
}

/** Comments out, so a doc comment naming `Headers` does not count. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
    // A webhook file: zod is fine elsewhere, never there; nor a protocol module that imports one.
    const webhookFile = join(WEBHOOK_DIR, 'verify.ts');
    expect(isAllowed('zod', 'import { z } ')).toBe(true);
    for (const specifier of ['zod', 'nostr-tools/pure', 'node:crypto', '../caip', '../index']) {
      expect(isWebhookImportAllowed(webhookFile, specifier)).toBe(false);
    }
    for (const specifier of ['./crypto', '../tags', '../constants']) {
      expect(isWebhookImportAllowed(webhookFile, specifier)).toBe(true);
    }
    // The nostr-tools root: types yes, code no.
    expect(isAllowed('nostr-tools', 'import type { NostrEvent } ')).toBe(true);
    expect(isAllowed('nostr-tools', 'import { SimplePool } ')).toBe(false);
  });
});

describe('the webhook subpath', () => {
  const webhookFiles = sourceFiles(WEBHOOK_DIR);

  it('finds the sources it guards', () => {
    expect(webhookFiles.map((file) => relative(WEBHOOK_DIR, file))).toContain('index.ts');
    expect(webhookFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('imports only its own files and import-free protocol modules, transitively', () => {
    const offenders: string[] = [];
    for (const file of webhookFiles) {
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!isWebhookImportAllowed(file, specifier)) {
          offenders.push(`${relative(SRC, file)}: ${specifier}`);
        }
      }
    }
    for (const file of WEBHOOK_ALLOWED_PARENT) {
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(SRC, file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no Node or DOM type in its declarations', () => {
    const declarations = withoutComments(readFileSync(join(DIST, 'webhook.d.ts'), 'utf8'));
    expect(declarations).toMatch(/verifyWebhook/);
    expect(declarations.match(WEBHOOK_DTS_FORBIDDEN_RE)?.[0]).toBeUndefined();
    expect(WEBHOOK_DTS_FORBIDDEN_RE.test(withoutComments('declare const h: Headers; // ok'))).toBe(
      true,
    );
    expect(WEBHOOK_DTS_FORBIDDEN_RE.test(withoutComments('/** Headers */ type X = 1;'))).toBe(
      false,
    );
  });

  it('builds to a bundle whose chunks import no package', () => {
    const seen = new Set<string>();
    const pending = [join(DIST, 'webhook.js')];
    const bare: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop() ?? '';
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      expect(existsSync(file)).toBe(true);
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (/^\.\.?\//.test(specifier)) {
          pending.push(resolve(dirname(file), specifier));
        } else {
          bare.push(`${relative(DIST, file)}: ${specifier}`);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
    expect(bare).toEqual([]);
  });
});
