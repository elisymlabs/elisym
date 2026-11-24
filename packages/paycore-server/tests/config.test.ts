import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  adminOriginFrom,
  configFromEnv,
  inboxRelaysFrom,
  rpcEnvNames,
} from '../src/config';

const KEY = 'cd'.repeat(32);
const BASE_ENV = {
  DATABASE_URL: 'postgres://paycore@db/paycore',
  PAYCORE_MASTER_KEY: KEY,
  PAYCORE_PUBLIC_BASE: 'https://api.paycore.example/',
};

describe('configFromEnv', () => {
  it('reads the defaults', () => {
    expect(configFromEnv(BASE_ENV)).toEqual({
      databaseUrl: BASE_ENV.DATABASE_URL,
      masterKeyHex: KEY,
      publicBase: 'https://api.paycore.example',
      port: DEFAULT_PORT,
      trustProxy: false,
      inboxRelays: ['wss://relay.elisym.network'],
      operator: 'api.paycore.example',
      rpcs: { mainnet: { evm: {} }, devnet: { evm: {} } },
    });
  });

  it('reads the operator RPCs per network', () => {
    const config = configFromEnv({
      ...BASE_ENV,
      PAYCORE_SOLANA_RPC_MAINNET: 'https://sol.example',
      PAYCORE_FEE_RPC_MAINNET: 'https://fee.example',
      PAYCORE_TEMPO_RPC_DEVNET: 'https://moderato.example',
      PAYCORE_EVM_RPC_BASE_MAINNET: 'https://base.example',
      PAYCORE_EVM_RPC_ARBITRUM_DEVNET: 'https://arb-sepolia.example',
    });
    expect(config.rpcs).toEqual({
      mainnet: {
        solana: 'https://sol.example',
        fee: 'https://fee.example',
        evm: { base: 'https://base.example' },
      },
      devnet: {
        tempo: 'https://moderato.example',
        evm: { arbitrum: 'https://arb-sepolia.example' },
      },
    });
    expect(rpcEnvNames('devnet').evm.ethereum).toBe('PAYCORE_EVM_RPC_ETHEREUM_DEVNET');
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_SOLANA_RPC_DEVNET: 'wss://x' })).toThrow(
      'PAYCORE_SOLANA_RPC_DEVNET',
    );
  });

  it('reads the master key from a file, never from both', () => {
    const { PAYCORE_MASTER_KEY: _key, ...withoutKey } = BASE_ENV;
    expect(
      configFromEnv({ ...withoutKey, PAYCORE_MASTER_KEY_FILE: '/run/secrets/k' }, () => `${KEY}\n`)
        .masterKeyHex,
    ).toBe(KEY);
    expect(() =>
      configFromEnv({ ...BASE_ENV, PAYCORE_MASTER_KEY_FILE: '/run/secrets/k' }, () => KEY),
    ).toThrow('not both');
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_MASTER_KEY: 'AB'.repeat(32) })).toThrow(
      'lowercase hex',
    );
    expect(() => configFromEnv(withoutKey)).toThrow('PAYCORE_MASTER_KEY is required');
  });

  it('takes a public base that is a bare origin and path only', () => {
    for (const base of [
      'https://api.paycore.example/?x=1',
      'https://api.paycore.example/#top',
      'https://user@api.paycore.example',
      'https://user:pass@api.paycore.example',
      'https://:pass@api.paycore.example',
    ]) {
      expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_PUBLIC_BASE: base }), base).toThrow(
        'bare origin and path',
      );
    }
    expect(
      configFromEnv({ ...BASE_ENV, PAYCORE_PUBLIC_BASE: 'https://api.paycore.example/paycore/' })
        .publicBase,
    ).toBe('https://api.paycore.example/paycore');
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_PUBLIC_BASE: 'not a url' })).toThrow(
      'must be a URL',
    );
  });

  it('checks the public base, operator, port and proxy flag', () => {
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_PUBLIC_BASE: 'http://api.example' })).toThrow(
      'https',
    );
    const local = { ...BASE_ENV, PAYCORE_PUBLIC_BASE: 'http://localhost:8790' };
    // A bare host names no service: local runs name the operator.
    expect(() => configFromEnv(local)).toThrow('PAYCORE_OPERATOR');
    expect(configFromEnv({ ...local, PAYCORE_OPERATOR: 'paycore.test' }).operator).toBe(
      'paycore.test',
    );
    expect(
      configFromEnv({ ...BASE_ENV, PAYCORE_OPERATOR: 'paycore.elisym.network' }).operator,
    ).toBe('paycore.elisym.network');
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_OPERATOR: 'Not A Host' })).toThrow(
      'PAYCORE_OPERATOR',
    );
    expect(configFromEnv({ ...BASE_ENV, PORT: '9000', PAYCORE_TRUST_PROXY: '1' })).toMatchObject({
      port: 9000,
      trustProxy: true,
    });
    expect(() => configFromEnv({ ...BASE_ENV, PORT: '70000' })).toThrow('PORT');
    expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_TRUST_PROXY: 'yes' })).toThrow();
    expect(configFromEnv({ ...BASE_ENV, PORT: '' }).port).toBe(DEFAULT_PORT);
  });
});

describe('PAYCORE_INBOX_RELAYS', () => {
  it('keeps public wss relays in the checkout spelling, once each', () => {
    expect(inboxRelaysFrom('wss://relay.elisym.network/, wss://nos.lol,wss://nos.lol')).toEqual([
      'wss://relay.elisym.network',
      'wss://nos.lol',
    ]);
  });

  it('refuses a local, private or plain relay', () => {
    for (const relay of ['ws://relay.example', 'wss://localhost', 'wss://10.0.0.1', '']) {
      expect(() => inboxRelaysFrom(relay), relay).toThrow('PAYCORE_INBOX_RELAYS');
    }
  });
});

describe('PAYCORE_ADMIN_ORIGIN', () => {
  it('takes an exact origin, and none when unset or empty', () => {
    expect(
      configFromEnv({ ...BASE_ENV, PAYCORE_ADMIN_ORIGIN: 'https://admin.elisym.network' })
        .adminOrigin,
    ).toBe('https://admin.elisym.network');
    expect(adminOriginFrom('https://admin.example:8443')).toBe('https://admin.example:8443');
    expect(adminOriginFrom('http://localhost:5173')).toBe('http://localhost:5173');
    expect(configFromEnv(BASE_ENV).adminOrigin).toBeUndefined();
    expect(configFromEnv({ ...BASE_ENV, PAYCORE_ADMIN_ORIGIN: '' }).adminOrigin).toBeUndefined();
  });

  it('refuses at boot anything the browser would not send as Origin byte for byte', () => {
    for (const value of [
      'https://admin.example/',
      'https://admin.example/hosted',
      'https://Admin.example',
      'https://admin.example:443',
      'https://admin.example?x=1',
      'https://user@admin.example',
      'http://admin.example',
      'admin.example',
      '*',
      'null',
    ]) {
      expect(() => configFromEnv({ ...BASE_ENV, PAYCORE_ADMIN_ORIGIN: value }), value).toThrow(
        'PAYCORE_ADMIN_ORIGIN',
      );
    }
  });
});
