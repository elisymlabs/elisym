import { describe, expect, it } from 'vitest';
import { PRODUCTION_ORIGIN, buildEnvProblems, checkoutOrigin } from '../scripts/build-env';

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
