import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_ORIGIN, RPC_ENV, buildEnvProblems, checkoutOrigin } from '../scripts/build-env';
import { EIP3009_CHAINS, eip3009RpcEnvName } from '../src/app/evm-rpc';

const WIDGET_KEY = 'https://mainnet.helius-rpc.com/?api-key=widget';

describe('the build environment', () => {
  it('lets a local or preview build go without any RPC', () => {
    expect(buildEnvProblems({})).toEqual([]);
    expect(buildEnvProblems({ VERCEL_ENV: 'preview' })).toEqual([]);
  });

  it('fails a production build without the mainnet RPC', () => {
    expect(buildEnvProblems({ VERCEL_ENV: 'production' })).toHaveLength(1);
    expect(
      buildEnvProblems({ VERCEL_ENV: 'production', VITE_SOLANA_RPC_URL_MAINNET: '' }),
    ).toHaveLength(1);
    expect(
      buildEnvProblems({ VERCEL_ENV: 'production', VITE_SOLANA_RPC_URL_MAINNET: WIDGET_KEY }),
    ).toEqual([]);
  });

  it('fails a production build on the public mainnet endpoint', () => {
    expect(
      buildEnvProblems({
        VERCEL_ENV: 'production',
        VITE_SOLANA_RPC_URL_MAINNET: 'https://api.mainnet-beta.solana.com',
      }),
    ).toHaveLength(1);
  });

  it('accepts only https RPC URLs, or http on this machine', () => {
    expect(buildEnvProblems({ VITE_SOLANA_RPC_URL_DEVNET: 'http://rpc.example.com' })).toHaveLength(
      1,
    );
    expect(buildEnvProblems({ VITE_SOLANA_RPC_URL_MAINNET: 'not a url' })).toHaveLength(1);
    expect(buildEnvProblems({ VITE_SOLANA_RPC_URL_DEVNET: 'http://127.0.0.1:8899' })).toEqual([]);
    expect(buildEnvProblems({ VITE_SOLANA_RPC_URL_DEVNET: 'https://devnet.example.com' })).toEqual(
      [],
    );
  });
});

describe('the origin the loader frames', () => {
  it('is production unless told otherwise', () => {
    expect(checkoutOrigin({})).toBe(PRODUCTION_ORIGIN);
    expect(checkoutOrigin({ VERCEL_ENV: 'production', VERCEL_URL: 'x.vercel.app' })).toBe(
      PRODUCTION_ORIGIN,
    );
  });

  it("is a preview's own deployment URL, so a preview never frames production", () => {
    expect(checkoutOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'pay-git-x.vercel.app' })).toBe(
      'https://pay-git-x.vercel.app',
    );
  });

  it('fails a preview that names no URL of its own', () => {
    expect(() => checkoutOrigin({ VERCEL_ENV: 'preview' })).toThrow('VERCEL_URL');
    expect(() => checkoutOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: '' })).toThrow('VERCEL_URL');
  });

  it('is CHECKOUT_ORIGIN when set, reduced to its origin', () => {
    expect(
      checkoutOrigin({
        CHECKOUT_ORIGIN: 'http://127.0.0.1:5174/checkout',
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'pay-git-x.vercel.app',
      }),
    ).toBe('http://127.0.0.1:5174');
  });
});

describe("the build's EVM RPC variables", () => {
  it('name one variable per eip3009 chain and network, each checked as an RPC URL', () => {
    const names = EIP3009_CHAINS.map((chain) => eip3009RpcEnvName(chain));
    expect(names.sort()).toEqual([
      'VITE_EVM_RPC_URL_ARBITRUM_DEVNET',
      'VITE_EVM_RPC_URL_ARBITRUM_MAINNET',
      'VITE_EVM_RPC_URL_BASE_DEVNET',
      'VITE_EVM_RPC_URL_BASE_MAINNET',
      'VITE_EVM_RPC_URL_ETHEREUM_DEVNET',
      'VITE_EVM_RPC_URL_ETHEREUM_MAINNET',
    ]);
    for (const name of names) {
      expect(RPC_ENV).toContain(name);
      expect(buildEnvProblems({ [name]: 'http://rpc.example.com' })).toEqual([
        `${name} must be https:`,
      ]);
      expect(buildEnvProblems({ [name]: 'not a url' })).toEqual([`${name} is not a URL`]);
      expect(buildEnvProblems({ [name]: 'https://rpc.example.com/v2/key' })).toEqual([]);
      expect(buildEnvProblems({ [name]: '' })).toEqual([]);
    }
  });

  it('are the same VITE_* names in RPC_ENV, the turbo build env and env.d.ts', () => {
    const turbo = JSON.parse(readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'));
    const turboEnv: string[] = turbo.tasks['@elisym/checkout#build'].env;
    const vite = (names: readonly string[]) =>
      names.filter((name) => name.startsWith('VITE_')).sort();
    expect(vite(turboEnv)).toEqual(vite(RPC_ENV));
    const declared = [
      ...readFileSync(new URL('../src/app/env.d.ts', import.meta.url), 'utf8').matchAll(
        /readonly (VITE_[A-Z_]+)\?:/g,
      ),
    ].map((match) => match[1] ?? '');
    expect(vite(declared)).toEqual(vite(RPC_ENV));
  });

  it('are each read by the app under its own name, so the build inlines it', () => {
    const main = readFileSync(new URL('../src/app/main.tsx', import.meta.url), 'utf8');
    for (const chain of EIP3009_CHAINS) {
      const name = eip3009RpcEnvName(chain);
      expect(main).toContain(`${name}: import.meta.env.${name},`);
    }
  });
});
