/**
 * Structural rules of the EVM rail, enforced over the source tree:
 * - an EVM library (viem) may be imported under `src/evm/` and nowhere else;
 * - nothing outside `src/evm/` imports from it, so the root bundle - and every
 *   client that only discovers and verifies - never pulls the rail in.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAINS, isEvmWireAddress } from '../src/payment/chains';
import { CONFIG_CONTRACT_MODERATO } from './evm-deployment';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

const outsideEvm = sourceFiles(SRC).filter((path) => !relative(SRC, path).startsWith(`evm${sep}`));

/**
 * Every form that pulls a module in: a static `from`, a bare side-effect
 * `import`, a dynamic `import()`, and `require()`. Matching only `from` left
 * three doors open, and the dynamic one is the door that matters - esbuild
 * inlines it, so the rail would reach the root bundle with the test still green.
 */
const IMPORT_FORMS = String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)`;
const VIEM_REFERENCE = new RegExp(IMPORT_FORMS + String.raw`['"]viem(?:/[^'"]*)?['"]`);
const RAIL_REFERENCE = new RegExp(
  IMPORT_FORMS +
    String.raw`['"](?:(?:\.\.?/)+(?:[\w-]+/)*evm(?:/[^'"]*)?|@elisym/(?:sdk|pay-core)/evm)['"]`,
);
/** A sentence only the rail carries, for looking inside a built bundle. */
const RAIL_MARKER = 'No elisym config contract is registered for';

const DIST = join(__dirname, '..', 'dist');
const RELATIVE_CHUNK = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/** A built entry and every file of this package it pulls in, transitively. */
function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file) || !existsSync(file)) {
      continue;
    }
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_CHUNK)) {
      const specifier = match[1];
      if (specifier) {
        pending.push(join(dirname(file), specifier));
      }
    }
  }
  return [...seen];
}

describe('the EVM rail stays in its own entry point', () => {
  it('finds source files to check', () => {
    // A sweep that finds nothing proves nothing. The number is a floor on this
    // package's own tree, not a measurement of it: the core is about twenty
    // files outside the rail, and it moved here from the SDK, where the same
    // floor was fifty because the marketplace was counted too.
    expect(outsideEvm.length).toBeGreaterThan(15);
  });

  // The rules above are two regular expressions, and a regular expression that
  // quietly matches nothing is a test that quietly proves nothing. These are the
  // forms they exist to catch, and the ones they must not fire on.
  it.each([
    ["import { getAddress } from 'viem';", true],
    ["import type { Hex } from 'viem';", true],
    ["import 'viem';", true],
    ["const lib = await import('viem');", true],
    ["const lib = require('viem');", true],
    ["import { toHex } from 'viem/utils';", true],
    ['// viem is deliberately not imported here', false],
    ["import { x } from 'viemlike';", false],
  ])('recognises %s as an EVM-library import: %s', (line, caught) => {
    expect(VIEM_REFERENCE.test(line)).toBe(caught);
  });

  it.each([
    ["import { getEvmProtocolConfig } from '../evm/config';", true],
    ["import { x } from './evm';", true],
    ["const rail = await import('../evm/config');", true],
    ["const rail = require('../../payment/evm/config');", true],
    ["import { x } from '@elisym/sdk/evm';", true],
    ["import { x } from '@elisym/pay-core/evm';", true],
    ["import { x } from '../payment/chains';", false],
    ["import { x } from './evmish';", false],
  ])('recognises %s as a rail import: %s', (line, caught) => {
    expect(RAIL_REFERENCE.test(line)).toBe(caught);
  });

  it('imports an EVM library only under src/evm', () => {
    const offenders = outsideEvm.filter((path) => VIEM_REFERENCE.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  it('is imported by nothing outside src/evm', () => {
    const offenders = outsideEvm.filter((path) => RAIL_REFERENCE.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  // The regexes above read SOURCE, and a bundler is what actually decides: a
  // form the source rules missed would land in the root bundle without a word.
  // This asserts the artefact itself. The package is built with code splitting,
  // so the root entry is its file PLUS every chunk it reaches - statically or
  // through a dynamic `import()` - and all of them are read.
  it('keeps the rail out of the built root bundle', () => {
    // The ORDER is structural, not asserted here: `turbo.json` makes this
    // package's `test` depend on its `build`, so inside `bun qa` this always
    // runs against fresh output. An mtime comparison would only add spurious
    // failures - a cache hit leaves `dist` untouched, so anything that rewrites
    // a source file's mtime without changing its content makes a current build
    // look stale.
    for (const name of ['dist/index.js', 'dist/index.cjs']) {
      const bundle = join(__dirname, '..', name);
      expect(
        existsSync(bundle),
        `${name} is missing - run \`bun run build --filter=@elisym/pay-core\` before this test`,
      ).toBe(true);
      const files = reachableFiles(bundle);
      // Split into chunks: an entry that reached nothing would prove nothing.
      expect(files.length, name).toBeGreaterThan(1);
      for (const file of files) {
        const built = readFileSync(file, 'utf8');
        expect(built, relative(DIST, file)).not.toContain(RAIL_MARKER);
        expect(built, relative(DIST, file)).not.toContain('viem');
        expect(built, relative(DIST, file)).not.toMatch(/@elisym\/(?:sdk|pay-core)\/evm/);
      }
    }
  });
});

describe('the chain registry', () => {
  it('names the config contract that was actually deployed and read back', () => {
    // A hand-reviewed constant with a recorded code hash (DEPLOYMENTS.md). A
    // typo or a bad merge here silently redirects every fee read on the chain,
    // and nothing else in the suite would notice: the other tests read the
    // address out of the registry they are asserting.
    expect(CHAINS.TEMPO_DEVNET.protocolConfig.address).toBe(CONFIG_CONTRACT_MODERATO);
  });

  it('names every config contract in wire form', () => {
    // The address goes verbatim into `eth_call`'s `to` and out again as
    // `EvmProtocolConfig.contract`; a checksummed one would work on the wire
    // and silently fail every equality downstream.
    for (const chain of Object.values(CHAINS)) {
      const address = 'protocolConfig' in chain ? chain.protocolConfig.address : undefined;
      if (address !== undefined) {
        expect(isEvmWireAddress(address)).toBe(true);
      }
    }
  });
});
