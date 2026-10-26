import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configProblems, priceProblems, configTemplate, loadConfig } from '../src/config';
import { EIP3009_USDC, PAYOUT, USDC_DEVNET_CAIP19 } from './fixtures';

const EVM_PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';

function baseSepolia() {
  const found = EIP3009_USDC.find(({ chain }) => chain.caip2 === 'eip155:84532');
  if (found === undefined) {
    throw new Error('no Base Sepolia USDC in the registry');
  }
  return found;
}

const EIP3009_BASE_SEPOLIA = baseSepolia();

const MAINNET_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEMPO_USDC = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';

function valid() {
  return {
    ...configTemplate('devnet'),
    payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT as string }],
  };
}

describe('the merchant config', () => {
  it('accepts a filled-in template', () => {
    expect(configProblems(valid())).toEqual([]);
    expect(
      configProblems({
        ...valid(),
        network: 'mainnet',
        payouts: [{ caip19: MAINNET_USDC, address: PAYOUT }],
      }),
    ).toEqual([]);
  });

  it('refuses the template as written: the payout address is a placeholder', () => {
    expect(configProblems(configTemplate('devnet'))).toEqual([
      'payouts.0.address: is not a Solana address',
    ]);
  });

  it('refuses a payout this node cannot verify', () => {
    expect(
      configProblems({ ...valid(), payouts: [{ caip19: MAINNET_USDC, address: PAYOUT }] }),
    ).toEqual(['payouts.0.caip19: is on mainnet, the node runs on devnet']);
    expect(
      configProblems({ ...valid(), payouts: [{ caip19: TEMPO_USDC, address: PAYOUT }] }),
    ).toEqual(['payouts.0.caip19: is a Tempo coin: add a "tempo" block for the node to verify it']);
    const twice = { caip19: USDC_DEVNET_CAIP19, address: PAYOUT as string };
    expect(configProblems({ ...valid(), payouts: [twice, twice] })).toEqual([
      'payouts.1.caip19: is listed twice: one payout per coin',
    ]);
    expect(configProblems({ ...valid(), payouts: [] })).toHaveLength(1);
  });

  // Settlement gating: an eip3009 coin is EVM, but never Tempo's: it needs an `evm` entry.
  it('checks every eip3009 USDC: three chains, mainnet and devnet', () => {
    expect(EIP3009_USDC.map(({ chain }) => chain.chainName)).toEqual([
      'Ethereum',
      'Sepolia',
      'Arbitrum One',
      'Arbitrum Sepolia',
      'Base',
      'Base Sepolia',
    ]);
  });

  it.each(EIP3009_USDC)(
    'refuses $chain.chainName USDC without an evm entry, even beside a Tempo block',
    ({ chain, caip19 }) => {
      expect(
        configProblems({
          ...valid(),
          network: chain.network,
          tempo: { network: chain.network === 'mainnet' ? 'mainnet' : 'moderato' },
          payouts: [{ caip19, address: EVM_PAYOUT }],
        }),
      ).toEqual([
        `payouts.0.caip19: is a coin of ${chain.chainName}: add "evm": { "${chain.slug}": { "rpcUrl": "https://..." } } for the node to verify it`,
      ]);
    },
  );

  it.each(EIP3009_USDC)(
    'takes $chain.chainName USDC with its evm entry, on the node network only',
    ({ chain, caip19 }) => {
      const config = {
        ...valid(),
        network: chain.network,
        evm: { [chain.slug]: { rpcUrl: 'https://rpc.example.com' } },
        payouts: [{ caip19, address: EVM_PAYOUT }],
      };
      expect(configProblems(config)).toEqual([]);
      const other = chain.network === 'mainnet' ? 'devnet' : 'mainnet';
      expect(configProblems({ ...config, network: other })).toEqual([
        `payouts.0.caip19: is on ${chain.network}, the node runs on ${other}`,
      ]);
      // An entry for another chain does not verify this one.
      const elsewhere = chain.slug === 'base' ? 'ethereum' : 'base';
      expect(
        configProblems({ ...config, evm: { [elsewhere]: { rpcUrl: 'https://rpc.example.com' } } }),
      ).toHaveLength(1);
    },
  );

  it('refuses an evm entry that breaks any of its schema rules', () => {
    const withBase = (base: unknown) => configProblems({ ...valid(), evm: { base } });
    // A fraction, zero, a negative, a string, null: each refused on that field (a cap
    // below the chain's minimum is refused besides, see the next test).
    for (const logRangeCap of [1000.5, 0, -1, '1000', null]) {
      const problems = withBase({ rpcUrl: 'https://rpc.example.com', logRangeCap });
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((problem) => problem.startsWith('evm.base.logRangeCap: '))).toBe(true);
    }
    expect(withBase({ rpcUrl: 'https://rpc.example.com', logRangeCap: 1000.5 })).toHaveLength(1);
    for (const credit of ['fast', 'safe']) {
      expect(withBase({ rpcUrl: 'https://rpc.example.com', credit })).toEqual([]);
    }
    for (const credit of ['latest', 'finalized', '', true, null]) {
      const problems = withBase({ rpcUrl: 'https://rpc.example.com', credit });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith('evm.base.credit: ')).toBe(true);
    }
    for (const rpcUrl of [
      undefined,
      'not a url',
      'http://rpc.example.com',
      'wss://rpc.example.com',
      7,
    ]) {
      expect(withBase({ rpcUrl })).toHaveLength(1);
    }
    // Strict: an unknown field in an entry, an unknown chain, an entry that is no object.
    expect(withBase({ rpcUrl: 'https://rpc.example.com', network: 'mainnet' })).toHaveLength(1);
    expect(
      configProblems({ ...valid(), evm: { optimism: { rpcUrl: 'https://rpc.example.com' } } }),
    ).toHaveLength(1);
    expect(withBase('https://rpc.example.com')).toHaveLength(1);
    expect(configProblems({ ...valid(), evm: [] })).toHaveLength(1);
    // A local http RPC is taken, as for the other rails.
    expect(withBase({ rpcUrl: 'http://localhost:8545' })).toEqual([]);
  });

  it('refuses an eip3009 payout a payment cannot reach', () => {
    const { chain, caip19 } = EIP3009_BASE_SEPOLIA;
    const config = {
      ...valid(),
      evm: { base: { rpcUrl: 'https://rpc.example.com' } },
    };
    const refusal = `payouts.0.address: is not an address a payment on ${chain.chainName} can go to (lowercase 0x, not the zero address or a coin contract)`;
    for (const address of [
      `0x${'0'.repeat(40)}`,
      // The USDC proxy itself, and another chain's USDC.
      caip19.split(':').at(-1) ?? '',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      EVM_PAYOUT.toUpperCase().replace('0X', '0x'),
      'not an address',
    ]) {
      expect(configProblems({ ...config, payouts: [{ caip19, address }] })).toEqual([refusal]);
    }
  });

  it('takes an evm entry with its own log range cap, never below the registry minimum', () => {
    const { caip19 } = EIP3009_BASE_SEPOLIA;
    const config = (logRangeCap: number) => ({
      ...valid(),
      evm: { base: { rpcUrl: 'https://rpc.example.com', logRangeCap } },
      payouts: [{ caip19, address: EVM_PAYOUT }],
    });
    expect(configProblems(config(1000))).toEqual([]);
    expect(configProblems(config(10_000))).toEqual([]);
    expect(configProblems(config(999))).toEqual([
      'evm.base.logRangeCap: must be at least 1000 blocks on Base Sepolia',
    ]);
    expect(
      configProblems({
        ...valid(),
        evm: { arbitrum: { rpcUrl: 'https://a.example', logRangeCap: 4999 } },
      }),
    ).toEqual(['evm.arbitrum.logRangeCap: must be at least 5000 blocks on Arbitrum Sepolia']);
    expect(
      configProblems({
        ...valid(),
        evm: { ethereum: { rpcUrl: 'https://e.example', logRangeCap: 99 } },
      }),
    ).toEqual(['evm.ethereum.logRangeCap: must be at least 100 blocks on Sepolia']);
    // An entry needs an https RPC, and names only the three chains.
    expect(configProblems({ ...valid(), evm: { base: {} } })).toHaveLength(1);
    expect(
      configProblems({ ...valid(), evm: { base: { rpcUrl: 'http://rpc.example.com' } } }),
    ).toHaveLength(1);
    expect(
      configProblems({ ...valid(), evm: { tempo: { rpcUrl: 'https://rpc.example.com' } } }),
    ).toHaveLength(1);
  });

  it('takes Tempo payouts on the configured Tempo network only, at a payable address', () => {
    const tempoPayout = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
    const withTempo = {
      ...valid(),
      network: 'mainnet',
      tempo: { network: 'mainnet' },
      payouts: [{ caip19: MAINNET_USDC, address: PAYOUT }],
    };
    expect(
      configProblems({
        ...withTempo,
        payouts: [...withTempo.payouts, { caip19: TEMPO_USDC, address: tempoPayout }],
      }),
    ).toEqual([]);
    // Moderato is the registry's devnet: a mainnet coin is refused there.
    expect(
      configProblems({
        ...valid(),
        tempo: { network: 'moderato' },
        payouts: [{ caip19: TEMPO_USDC, address: tempoPayout }],
      }),
    ).toEqual(['payouts.0.caip19: is not on Tempo moderato']);
    for (const address of [
      tempoPayout.toUpperCase().replace('0X', '0x'),
      '0x20c000000000000000000000b9537d11c60e8b50',
    ]) {
      expect(
        configProblems({ ...withTempo, payouts: [{ caip19: TEMPO_USDC, address }] }),
      ).toHaveLength(1);
    }
  });

  it('refuses a Tempo network other than the node network', () => {
    const moderatoPathUsd = 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000';
    const tempoPayout = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
    // A mainnet store paid in a testnet coin: any page framing it on devnet gets a real delivery.
    expect(
      configProblems({
        ...valid(),
        network: 'mainnet',
        tempo: { network: 'moderato' },
        payouts: [
          { caip19: MAINNET_USDC, address: PAYOUT },
          { caip19: moderatoPathUsd, address: tempoPayout },
        ],
      }),
    ).toEqual([
      'tempo.network: is moderato, the node runs on mainnet: use network "mainnet" with Tempo "mainnet", or network "devnet" with Tempo "moderato"',
    ]);
    expect(
      configProblems({
        ...valid(),
        tempo: { network: 'mainnet' },
        payouts: [...valid().payouts, { caip19: TEMPO_USDC, address: tempoPayout }],
      }),
    ).toEqual([
      'tempo.network: is mainnet, the node runs on devnet: use network "mainnet" with Tempo "mainnet", or network "devnet" with Tempo "moderato"',
    ]);
    expect(
      configProblems({
        ...valid(),
        tempo: { network: 'moderato' },
        payouts: [...valid().payouts, { caip19: moderatoPathUsd, address: tempoPayout }],
      }),
    ).toEqual([]);
  });

  it('needs the Solana RPC only with a Solana payout', () => {
    const tempoOnly = {
      ...valid(),
      network: 'mainnet',
      tempo: { network: 'mainnet' },
      payouts: [{ caip19: TEMPO_USDC, address: '0x5696da2cecea22f127948458382ac2c59bc8e4bb' }],
    };
    const { rpcUrl: _dropped, ...withoutRpc } = tempoOnly;
    expect(configProblems(withoutRpc)).toEqual([]);
    const { rpcUrl: _solana, ...solanaWithoutRpc } = valid();
    expect(configProblems(solanaWithoutRpc)).toEqual(['rpcUrl: is required with a Solana payout']);
  });

  it('refuses an inbox relay the checkout never contacts, or one listed twice', () => {
    for (const relay of ['wss://10.0.0.5', 'wss://127.0.0.1:7777', 'wss://localhost']) {
      expect(configProblems({ ...valid(), inboxRelays: [relay] })).toHaveLength(1);
    }
    expect(
      configProblems({ ...valid(), inboxRelays: ['wss://nos.lol', 'wss://nos.lol/'] }),
    ).toEqual(['inboxRelays.1: is listed twice']);
    // A local relay for tests.
    expect(configProblems({ ...valid(), inboxRelays: ['ws://localhost:7777'] })).toEqual([]);
  });

  it('refuses insecure or malformed endpoints', () => {
    expect(configProblems({ ...valid(), rpcUrl: 'http://rpc.example.com' })).toHaveLength(1);
    expect(configProblems({ ...valid(), rpcUrl: 'http://127.0.0.1:8899' })).toEqual([]);
    expect(configProblems({ ...valid(), inboxRelays: ['ws://relay.example.com'] })).toHaveLength(1);
    expect(configProblems({ ...valid(), inboxRelays: [] })).toHaveLength(1);
    expect(
      configProblems({
        ...valid(),
        inboxRelays: Array.from({ length: 6 }, (_, index) => `wss://r${index}.example.com`),
      }),
    ).toHaveLength(1);
  });

  it('refuses a 0.7 config, which names its one product, as an old home', () => {
    expect(configProblems({ ...valid(), product: { d: 'x' } })).toEqual([
      'this home was made by merchant-node 0.7 or earlier: create a new home with init',
    ]);
  });

  it('refuses a coin that cannot be paid a product price, and the name "owner"', () => {
    const lsm =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
    const config = {
      ...valid(),
      network: 'mainnet' as const,
      payouts: [{ caip19: lsm, address: PAYOUT }],
    };
    expect(configProblems(config)).toEqual([]);
    expect(
      priceProblems(config, [
        {
          d: 'course',
          title: 'Course',
          description: '',
          priceUsd: '1',
          onSale: true,
          file: 'x',
        },
      ]),
    ).toEqual(['products/course: LSM cannot be paid its price of 1 USD']);
    expect(configProblems({ ...valid(), nip05: 'owner@shop.example' })).toHaveLength(1);
  });

  it('refuses unknown fields and a bad nip05', () => {
    expect(configProblems({ ...valid(), delivery: {} })).toHaveLength(1);
    expect(configProblems({ ...valid(), nip05: 'not a nip05' })).toHaveLength(1);
    expect(configProblems({ ...valid(), nip05: '_@shop.example' })).toEqual([]);
  });

  it('loads inbox relays in the one spelling the checkout uses', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'merchant-config-')), 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...valid(),
        inboxRelays: [
          'wss://Relay.Elisym.Network/',
          'wss://nos.lol//inbox/',
          'ws://localhost:7777/',
        ],
      }),
    );
    expect(loadConfig(path).inboxRelays).toEqual([
      'wss://relay.elisym.network',
      'wss://nos.lol/inbox',
      'ws://localhost:7777/',
    ]);
  });
});
