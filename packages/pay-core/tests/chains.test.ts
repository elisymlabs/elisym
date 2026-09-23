import { describe, expect, it } from 'vitest';
import {
  ALL_ASSETS,
  EVM_ASSETS,
  KNOWN_ASSETS,
  NATIVE_SOL,
  PATHUSD_TEMPO,
  USDCE_TEMPO_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  assetByKey,
  assetKey,
  assetsFor,
  defaultStablecoin,
  resolveAssetFromPaymentRequest,
  resolveKnownAsset,
} from '@elisym/pay-core';
import {
  CHAINS,
  chainByCaip2,
  chainFamilyOf,
  chainFor,
  explorerTxUrl,
  isChainSlug,
  isEvmAddressFormat,
  isEvmTxHashFormat,
  isEvmWireAddress,
  isEvmWireTxHash,
  isVirtualEvmAddress,
  normalizeEvmAddress,
} from '@elisym/pay-core';

describe('the chain registry', () => {
  it('has one entry per (chain, environment) and a unique CAIP-2 id for each', () => {
    const entries = Object.values(CHAINS);
    const pairs = entries.map((chain) => `${chain.slug}:${chain.network}`);
    expect(new Set(pairs).size).toBe(entries.length);
    expect(new Set(entries.map((chain) => chain.caip2)).size).toBe(entries.length);
    for (const slug of ['solana', 'tempo'] as const) {
      for (const network of ['mainnet', 'devnet'] as const) {
        expect(chainFor(slug, network).network).toBe(network);
      }
    }
  });

  it('names an EVM chain eip155:<id>, and the id is the one eth_chainId must answer', () => {
    for (const chain of Object.values(CHAINS)) {
      if (chain.family === 'evm') {
        expect(chain.caip2).toBe(`eip155:${chain.evmChainId}`);
      } else {
        expect(chain.caip2.startsWith('solana:')).toBe(true);
        expect('evmChainId' in chain).toBe(false);
      }
    }
    expect(CHAINS.TEMPO_MAINNET.evmChainId).toBe(4217);
    expect(CHAINS.TEMPO_DEVNET.evmChainId).toBe(42431);
  });

  it('resolves by CAIP-2 and refuses what it does not know', () => {
    expect(chainByCaip2('eip155:4217')).toBe(CHAINS.TEMPO_MAINNET);
    expect(chainByCaip2('eip155:1')).toBeUndefined();
    // An id that EXTENDS a registry id is another chain: 42170 is Arbitrum Nova.
    expect(chainByCaip2('eip155:42170')).toBeUndefined();
    expect(chainByCaip2('eip155:421')).toBeUndefined();
    // The Wallet Standard id the web app uses is NOT CAIP-2.
    expect(chainByCaip2('solana:mainnet')).toBeUndefined();
    expect(chainFamilyOf('tempo')).toBe('evm');
    expect(chainFamilyOf('solana')).toBe('solana');
    expect(chainFamilyOf('base')).toBeUndefined();
    expect(isChainSlug('tempo')).toBe(true);
    expect(isChainSlug('Tempo')).toBe(false);
    expect(isChainSlug(undefined)).toBe(false);
  });

  it('throws for an environment it does not know, rather than returning nothing', () => {
    // Types make this unreachable; a `network` cast from a config file or an env var does not.
    expect(() => chainFor('tempo', 'testnet' as never)).toThrow(/No registry entry/);
  });

  it('builds an explorer link without letting the id escape the path', () => {
    expect(explorerTxUrl(CHAINS.TEMPO_MAINNET, '0xabc')).toBe('https://explore.tempo.xyz/tx/0xabc');
    expect(explorerTxUrl(CHAINS.SOLANA_DEVNET, 'sig')).toBe(
      'https://explorer.solana.com/tx/sig?cluster=devnet',
    );
    expect(explorerTxUrl(CHAINS.TEMPO_MAINNET, '../../evil?x=1')).toBe(
      'https://explore.tempo.xyz/tx/..%2F..%2Fevil%3Fx%3D1',
    );
  });
});

describe('EVM string checks (no keccak here)', () => {
  const address = '0x716ebf6bef1c3f27ea5c315ecfc60527d97041a2';

  it('checks shape only', () => {
    expect(isEvmAddressFormat(address)).toBe(true);
    expect(isEvmAddressFormat(address.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isEvmAddressFormat(address.slice(0, -1))).toBe(false);
    expect(isEvmAddressFormat(`${address}0`)).toBe(false);
    expect(isEvmAddressFormat(address.slice(2))).toBe(false);
    expect(isEvmAddressFormat(42)).toBe(false);
    // An ARRAY coerces to a matching string in a regex test: only the typeof guard
    // keeps a `value is string` predicate from lying, and its caller from throwing.
    expect(isEvmAddressFormat([address])).toBe(false);
    expect(isEvmWireAddress([address])).toBe(false);
    expect(isEvmTxHashFormat([`0x${'ab'.repeat(32)}`])).toBe(false);
    expect(isEvmWireTxHash([`0x${'ab'.repeat(32)}`])).toBe(false);
    expect(normalizeEvmAddress([address])).toBeUndefined();
    expect(isEvmTxHashFormat(`0x${'ab'.repeat(32)}`)).toBe(true);
    expect(isEvmTxHashFormat(`0x${'ab'.repeat(31)}`)).toBe(false);
    expect(isEvmTxHashFormat(null)).toBe(false);
  });

  it('knows the wire form: lowercase only', () => {
    expect(isEvmWireAddress(address)).toBe(true);
    expect(isEvmWireAddress('0x716EBf6Bef1C3f27ea5c315eCfc60527d97041A2')).toBe(false);
    expect(isEvmWireTxHash(`0x${'c4'.repeat(32)}`)).toBe(true);
    expect(isEvmWireTxHash(`0x${'C4'.repeat(32)}`)).toBe(false);
    expect(isEvmWireTxHash(`0x${'c4'.repeat(31)}`)).toBe(false);
    // Too LONG as well as too short: the regexes are anchored at both ends.
    expect(isEvmWireTxHash(`0x${'c4'.repeat(33)}`)).toBe(false);
    expect(isEvmWireAddress(`0x${'ab'.repeat(21)}`)).toBe(false);
    expect(isEvmWireAddress(`0x${'ab'.repeat(19)}`)).toBe(false);
  });

  it('normalizes to the lowercase wire form, or nothing', () => {
    expect(normalizeEvmAddress('0x716EBf6Bef1C3f27ea5c315eCfc60527d97041A2')).toBe(address);
    expect(normalizeEvmAddress('not an address')).toBeUndefined();
  });

  it('recognises a TIP-1022 virtual address: bytes 4 to 14 are 0xfd', () => {
    expect(isVirtualEvmAddress('0x11223344fdfdfdfdfdfdfdfdfdfd556677889900')).toBe(true);
    expect(isVirtualEvmAddress('0x11223344FDFDFDFDFDFDFDFDFDFD556677889900')).toBe(true);
    // One byte short of the marker, and the marker one byte off its place.
    expect(isVirtualEvmAddress('0x11223344fdfdfdfdfdfdfdfdfd00556677889900')).toBe(false);
    expect(isVirtualEvmAddress('0x112233fdfdfdfdfdfdfdfdfdfd44556677889900')).toBe(false);
    expect(isVirtualEvmAddress(address)).toBe(false);
    expect(isVirtualEvmAddress('garbage')).toBe(false);
  });
});

describe('the asset lists', () => {
  it('keeps KNOWN_ASSETS Solana-only: its consumers run every mint through a base58 parser', () => {
    expect(KNOWN_ASSETS.every((asset) => asset.chain === 'solana')).toBe(true);
    expect(EVM_ASSETS.every((asset) => asset.chain !== 'solana')).toBe(true);
    expect(ALL_ASSETS).toHaveLength(KNOWN_ASSETS.length + EVM_ASSETS.length);
    expect(new Set(ALL_ASSETS.map(assetKey)).size).toBe(ALL_ASSETS.length);
  });

  it('writes EVM contracts in the lowercase wire form, with dot-free token ids', () => {
    for (const asset of EVM_ASSETS) {
      expect(asset.mint).toMatch(/^0x[0-9a-f]{40}$/);
      expect(asset.token).toMatch(/^[a-z0-9-]+$/);
    }
    expect(USDCE_TEMPO_MAINNET.symbol).toBe('USDC.e');
  });

  it('finds an EVM coin through the shared lookups', () => {
    expect(resolveKnownAsset('tempo', 'pathusd', PATHUSD_TEMPO.mint)).toBe(PATHUSD_TEMPO);
    expect(assetByKey(assetKey(USDCE_TEMPO_MAINNET))).toBe(USDCE_TEMPO_MAINNET);
    // A Solana token id on the other chain is a different asset, and unknown.
    expect(resolveKnownAsset('tempo', 'usdc', USDC_SOLANA_MAINNET.mint)).toBeUndefined();
    expect(resolveKnownAsset('solana', 'pathusd', PATHUSD_TEMPO.mint)).toBeUndefined();
  });

  it('lists the coins of a chain per environment, and its default stablecoin', () => {
    expect(assetsFor('tempo', 'mainnet')).toEqual([USDCE_TEMPO_MAINNET, PATHUSD_TEMPO]);
    // USDC.e does not exist on Moderato.
    expect(assetsFor('tempo', 'devnet')).toEqual([PATHUSD_TEMPO]);
    expect(assetsFor('solana', 'devnet')).toEqual([NATIVE_SOL, USDC_SOLANA_DEVNET]);
    expect(defaultStablecoin('tempo', 'mainnet')).toBe(USDCE_TEMPO_MAINNET);
    expect(defaultStablecoin('tempo', 'devnet')).toBe(PATHUSD_TEMPO);
    expect(defaultStablecoin('solana', 'mainnet')).toBe(USDC_SOLANA_MAINNET);
    for (const chain of ['solana', 'tempo'] as const) {
      for (const network of ['mainnet', 'devnet'] as const) {
        expect(assetsFor(chain, network)).toContain(defaultStablecoin(chain, network));
      }
    }
  });

  it('never resolves an EVM coin for a v1 request: v1 settles on Solana', () => {
    // Were this to resolve, the Solana payment code would be handed an 0x contract as a mint.
    expect(() =>
      resolveAssetFromPaymentRequest({
        asset: { chain: 'tempo', token: 'pathusd', mint: PATHUSD_TEMPO.mint },
      }),
    ).toThrow(/Unknown asset/);
    expect(resolveAssetFromPaymentRequest({})).toBe(NATIVE_SOL);
  });

  it('accepts and rejects exactly what it always did for a mint that is not a string', () => {
    // The key is a template string over whatever the provider sent, as before: a
    // truthy non-string mint misses and throws; a falsy one reads as "no mint".
    for (const mint of [123, {}, true, []]) {
      const request = { asset: { chain: 'solana', token: 'sol', mint } };
      expect(() => resolveAssetFromPaymentRequest(request as never)).toThrow(/Unknown asset/);
    }
    for (const mint of [null, 0, '', false]) {
      const request = { asset: { chain: 'solana', token: 'sol', mint } };
      expect(resolveAssetFromPaymentRequest(request as never)).toBe(NATIVE_SOL);
    }
  });

  it('refuses a v2-shaped asset by name, not with a TypeError', () => {
    // The resolver runs before any schema. A v2 request's `asset` is a CAIP-19
    // string; the released builds crash on it inside the error formatter.
    const v2Shaped = { asset: 'eip155:4217/erc20:0x20c0000000000000000000000000000000000000' };
    for (const hostile of [v2Shaped, { asset: { chain: 5, token: 'usdc' } }, { asset: 7 }]) {
      expect(() => resolveAssetFromPaymentRequest(hostile as never)).toThrow(/Unknown asset/);
      expect(() => resolveAssetFromPaymentRequest(hostile as never)).not.toThrow(TypeError);
    }
  });
});
