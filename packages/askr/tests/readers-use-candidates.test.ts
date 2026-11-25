import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(__dirname, '..', '..');

/**
 * Every config reader of askr-shopify plan 2: each takes its config from
 * `configCandidates`. The widget's store check and the server's
 * `config-read.ts` and catalog loader go through these (`readStoreConfig`,
 * `storeConfig`).
 */
const READERS = [
  'askr-widget/src/store-data.ts',
  'askr-server/src/worker/catalog.ts',
  'askr-admin/src/lib/store-data.ts',
  'cli/src/commands/askr/read.ts',
  'mcp/src/tools/askr.ts',
];

describe('config readers (askr-shopify 1.3)', () => {
  it.each(READERS)('%s picks from configCandidates and never parses a candidate itself', (path) => {
    const source = readFileSync(join(PACKAGES, path), 'utf8');
    expect(source).toMatch(/configCandidates\(/u);
    expect(source).not.toMatch(/parseConfig\(/u);
  });
});
