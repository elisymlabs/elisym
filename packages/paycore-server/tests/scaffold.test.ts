import { existsSync, readFileSync } from 'node:fs';
import { emptyLedger } from '@merchant-node/ledger';
import { startStoreNode } from '@merchant-node/store-node';
import { describe, expect, it } from 'vitest';

const BUNDLE = new URL('../dist/main.js', import.meta.url);

describe('the merchant-node code', () => {
  it('is reachable through the alias', () => {
    expect(typeof startStoreNode).toBe('function');
    expect(emptyLedger().version).toBe(5);
  });

  it('is bundled without the merchant CLI, which runs on load', () => {
    // turbo builds before it tests (`@elisym/paycore-server#test` depends on `build`).
    expect(existsSync(BUNDLE)).toBe(true);
    const bundle = readFileSync(BUNDLE, 'utf8');
    expect(bundle).toContain('startStoreNode');
    expect(bundle).not.toContain('elisym-merchant <command>');
  });
});
