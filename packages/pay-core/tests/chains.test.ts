import { describe, expect, it } from 'vitest';
import { TEMPO_UNPAYABLE_ADDRESSES as EVM_ENTRY_UNPAYABLE_ADDRESSES } from '../src/evm/index';
import {
  ALL_ASSETS,
  EVM_ASSETS,
  KNOWN_ASSETS,
  NATIVE_SOL,
  PATHUSD_TEMPO,
  USDCE_TEMPO_MAINNET,
  USDC_ARBITRUM_DEVNET,
  USDC_ARBITRUM_MAINNET,
  USDC_BASE_DEVNET,
  USDC_BASE_MAINNET,
  USDC_ETHEREUM_DEVNET,
  USDC_ETHEREUM_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  assetByKey,
  assetKey,
  assetsFor,
  defaultStablecoin,
  resolveAssetFromPaymentRequest,
  resolveKnownAsset,
} from '../src/payment/assets';
import {
  CHAINS,
  COIN_CONTRACTS,
  TEMPO_UNPAYABLE_ADDRESSES,
  chainByCaip2,
  chainFamilyOf,
  chainFor,
  explorerTxUrl,
  isChainSlug,
  isEvmAddressFormat,
  isEvmTxHashFormat,
  isEvmWireAddress,
  isEvmWireTxHash,
  isPayable,
  isVirtualEvmAddress,
  isTempoChain,
  isTempoSlug,
  normalizeEvmAddress,
  settlementOf,
} from '../src/payment/chains';

describe('the chain registry', () => {
  it('has one entry per (chain, environment) and a unique CAIP-2 id for each', () => {
    const entries = Object.values(CHAINS);
    const pairs = entries.map((chain) => `${chain.slug}:${chain.network}`);
    expect(new Set(pairs).size).toBe(entries.length);
    expect(new Set(entries.map((chain) => chain.caip2)).size).toBe(entries.length);
    for (const slug of ['solana', 'tempo', 'ethereum', 'arbitrum', 'base'] as const) {
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
    // A chain the registry will never hold (OP Mainnet), not one it might.
    expect(chainByCaip2('eip155:10')).toBeUndefined();
    // An id that EXTENDS a registry id is another chain: 42170 is Arbitrum Nova.
    expect(chainByCaip2('eip155:42170')).toBeUndefined();
    expect(chainByCaip2('eip155:421')).toBeUndefined();
    // The Wallet Standard id the web app uses is NOT CAIP-2.
    expect(chainByCaip2('solana:mainnet')).toBeUndefined();
    expect(chainFamilyOf('tempo')).toBe('evm');
    expect(chainFamilyOf('solana')).toBe('solana');
    expect(chainFamilyOf('base')).toBe('evm');
    expect(chainFamilyOf('optimism')).toBeUndefined();
    for (const slug of ['solana', 'tempo', 'ethereum', 'arbitrum', 'base']) {
      expect(isChainSlug(slug)).toBe(true);
    }
    expect(isChainSlug('Tempo')).toBe(false);
    expect(isChainSlug(undefined)).toBe(false);
  });

  it('names the rail of every chain by settlement, never by family', () => {
    expect(settlementOf(CHAINS.SOLANA_MAINNET)).toBe('solana');
    expect(settlementOf(CHAINS.TEMPO_MAINNET)).toBe('tempo');
    expect(settlementOf(CHAINS.TEMPO_DEVNET)).toBe('tempo');
    const eip3009 = [
      CHAINS.ETHEREUM_MAINNET,
      CHAINS.ETHEREUM_DEVNET,
      CHAINS.ARBITRUM_MAINNET,
      CHAINS.ARBITRUM_DEVNET,
      CHAINS.BASE_MAINNET,
      CHAINS.BASE_DEVNET,
    ];
    for (const chain of eip3009) {
      expect(chain.family).toBe('evm');
      expect(settlementOf(chain)).toBe('eip3009');
      expect(isTempoChain(chain)).toBe(false);
    }
    expect(isTempoChain(CHAINS.TEMPO_DEVNET)).toBe(true);
    expect(isTempoChain(CHAINS.SOLANA_DEVNET)).toBe(false);
    expect(isTempoChain(undefined)).toBe(false);
    expect(isTempoSlug('tempo')).toBe(true);
    expect(isTempoSlug('base')).toBe(false);
    expect(isTempoSlug('solana')).toBe(false);
    // The CAIP-2 prefix says nothing about the rail.
    expect(settlementOf({ family: 'evm' })).toBeUndefined();
  });

  it('carries the eip3009 chain facts the rail reads (facts file)', () => {
    const expected = [
      [CHAINS.ETHEREUM_MAINNET, 1, 100, { creditSecs: 900, finalizedSecs: 1500 }],
      [CHAINS.ETHEREUM_DEVNET, 11155111, 100, { creditSecs: 900, finalizedSecs: 1500 }],
      [CHAINS.ARBITRUM_MAINNET, 42161, 5000, { creditSecs: 1200, finalizedSecs: 1800 }],
      [CHAINS.ARBITRUM_DEVNET, 421614, 5000, { creditSecs: 1200, finalizedSecs: 1800 }],
      [CHAINS.BASE_MAINNET, 8453, 1000, { creditSecs: 300, finalizedSecs: 1800 }],
      [CHAINS.BASE_DEVNET, 84532, 1000, { creditSecs: 300, finalizedSecs: 3000 }],
    ] as const;
    for (const [chain, id, cap, waits] of expected) {
      expect(chain.evmChainId).toBe(id);
      expect(chain.logRangeCap).toBe(cap);
      expect(chain.waits).toEqual(waits);
      expect(chain.finality).toEqual({ credit: 'safe' });
      expect(chain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
      expect(chain.knownDelegates).toEqual(['0x63c0c19a282a1b52b07dd5a65b58948a07dae32b']);
    }
    expect(CHAINS.BASE_MAINNET.l1FeeOracle).toBe('0x420000000000000000000000000000000000000f');
    expect(CHAINS.BASE_DEVNET.l1FeeOracle).toBe('0x420000000000000000000000000000000000000f');
    expect('l1FeeOracle' in CHAINS.ETHEREUM_MAINNET).toBe(false);
    expect('l1FeeOracle' in CHAINS.ARBITRUM_MAINNET).toBe(false);
    expect('knownDelegates' in CHAINS.TEMPO_MAINNET).toBe(false);
    // What a wallet adds Tempo under: the same names and gas coin as before the registry held them.
    const usd = { name: 'USD', symbol: 'USD', decimals: 18 };
    expect([CHAINS.TEMPO_MAINNET.chainName, CHAINS.TEMPO_MAINNET.nativeCurrency]).toEqual([
      'Tempo',
      usd,
    ]);
    expect([CHAINS.TEMPO_DEVNET.chainName, CHAINS.TEMPO_DEVNET.nativeCurrency]).toEqual([
      'Tempo Moderato',
      usd,
    ]);
    // The pinned FiatToken implementation behind each proxy (facts file).
    expect(
      [
        USDC_ETHEREUM_MAINNET,
        USDC_ARBITRUM_MAINNET,
        USDC_BASE_MAINNET,
        USDC_ETHEREUM_DEVNET,
        USDC_ARBITRUM_DEVNET,
        USDC_BASE_DEVNET,
      ].map((asset) => asset.implementation),
    ).toEqual([
      '0x43506849d7c04f9138d1a2050bbf3a0c054402dd',
      '0x86e721b43d4ecfa71119dd38c0f938a75fdb57b3',
      '0x2ce6311ddae708829bc0784c967b7d77d19fd779',
      '0xda317c1d3e835dd5f1be459006471acaa1289068',
      '0xfbb8ee011af0f15ee171e79c0688d05a58f7f566',
      '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5',
    ]);
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

  it('links each eip3009 chain to its own explorer and public fallback rpc', () => {
    const linksByChain = [
      [
        CHAINS.ETHEREUM_MAINNET,
        'https://etherscan.io/tx/0xabc',
        'https://ethereum-rpc.publicnode.com',
      ],
      [
        CHAINS.ETHEREUM_DEVNET,
        'https://sepolia.etherscan.io/tx/0xabc',
        'https://ethereum-sepolia-rpc.publicnode.com',
      ],
      [CHAINS.ARBITRUM_MAINNET, 'https://arbiscan.io/tx/0xabc', 'https://arb1.arbitrum.io/rpc'],
      [
        CHAINS.ARBITRUM_DEVNET,
        'https://sepolia.arbiscan.io/tx/0xabc',
        'https://sepolia-rollup.arbitrum.io/rpc',
      ],
      [CHAINS.BASE_MAINNET, 'https://basescan.org/tx/0xabc', 'https://mainnet.base.org'],
      [CHAINS.BASE_DEVNET, 'https://sepolia.basescan.org/tx/0xabc', 'https://sepolia.base.org'],
    ] as const;
    for (const [chain, explorerLink, rpcUrl] of linksByChain) {
      expect(explorerTxUrl(chain, '0xabc')).toBe(explorerLink);
      expect(chain.rpcUrls).toEqual([rpcUrl]);
    }
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

describe('isPayable (the EVM payability rule, rail-neutral)', () => {
  it('refuses the system accounts, the coin contracts and virtual addresses', () => {
    for (const address of [...TEMPO_UNPAYABLE_ADDRESSES, ...COIN_CONTRACTS]) {
      expect(isPayable(address)).toBe(false);
    }
    expect(COIN_CONTRACTS).toEqual(EVM_ASSETS.map((coin) => (coin.mint ?? '').toLowerCase()));
    expect(isPayable(`0x11223344${'fd'.repeat(10)}556677889900`)).toBe(false);
    expect(isPayable('0x7edb1404ebae28332867756c0d01440b9e63f3f7')).toBe(true);
  });

  it('lists every EVM coin the registry offers in EVM_ASSETS', () => {
    // COIN_CONTRACTS and the mcp cap test both derive from EVM_ASSETS, so a
    // coin missing from it would go unnoticed by both: check it against what
    // each chain actually offers.
    const listed = new Set(EVM_ASSETS.map((coin) => assetKey(coin)));
    const evmChains = Object.values(CHAINS).filter((chain) => chain.family === 'evm');
    expect(evmChains.length).toBeGreaterThan(6);
    for (const chain of evmChains) {
      for (const coin of assetsFor(chain.slug, chain.network)) {
        expect(listed.has(assetKey(coin)), `${chain.caip2} ${coin.symbol}`).toBe(true);
      }
    }
  });

  it.each([
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  ])('refuses the USDC contract %s as a payout (facts file)', (address) => {
    expect(isPayable(address)).toBe(false);
  });

  it('is still published from the evm entry, the same list', () => {
    expect(EVM_ENTRY_UNPAYABLE_ADDRESSES).toBe(TEMPO_UNPAYABLE_ADDRESSES);
    expect(TEMPO_UNPAYABLE_ADDRESSES).toHaveLength(5);
  });
});

describe('the eip3009 registry, every field pinned', () => {
  // pay-core is frozen after these chains ship: no field may move unnoticed.
  const ETHER = { name: 'Ether', symbol: 'ETH', decimals: 18 };
  const DELEGATES = ['0x63c0c19a282a1b52b07dd5a65b58948a07dae32b'];
  const ORACLE = '0x420000000000000000000000000000000000000f';
  const chain = (fields: Record<string, unknown>): Record<string, unknown> => ({
    family: 'evm',
    settlement: 'eip3009',
    nativeCurrency: ETHER,
    finality: { credit: 'safe' },
    knownDelegates: DELEGATES,
    ...fields,
  });

  it('pins each eip3009 chain entry whole', () => {
    expect(CHAINS.ETHEREUM_MAINNET).toEqual(
      chain({
        slug: 'ethereum',
        network: 'mainnet',
        caip2: 'eip155:1',
        evmChainId: 1,
        rpcUrls: ['https://ethereum-rpc.publicnode.com'],
        explorerTx: 'https://etherscan.io/tx/{tx}',
        chainName: 'Ethereum',
        logRangeCap: 100,
        waits: { creditSecs: 900, finalizedSecs: 1500 },
      }),
    );
    expect(CHAINS.ETHEREUM_DEVNET).toEqual(
      chain({
        slug: 'ethereum',
        network: 'devnet',
        caip2: 'eip155:11155111',
        evmChainId: 11155111,
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
        explorerTx: 'https://sepolia.etherscan.io/tx/{tx}',
        chainName: 'Sepolia',
        logRangeCap: 100,
        waits: { creditSecs: 900, finalizedSecs: 1500 },
      }),
    );
    expect(CHAINS.ARBITRUM_MAINNET).toEqual(
      chain({
        slug: 'arbitrum',
        network: 'mainnet',
        caip2: 'eip155:42161',
        evmChainId: 42161,
        rpcUrls: ['https://arb1.arbitrum.io/rpc'],
        explorerTx: 'https://arbiscan.io/tx/{tx}',
        chainName: 'Arbitrum One',
        logRangeCap: 5000,
        waits: { creditSecs: 1200, finalizedSecs: 1800 },
      }),
    );
    expect(CHAINS.ARBITRUM_DEVNET).toEqual(
      chain({
        slug: 'arbitrum',
        network: 'devnet',
        caip2: 'eip155:421614',
        evmChainId: 421614,
        rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
        explorerTx: 'https://sepolia.arbiscan.io/tx/{tx}',
        chainName: 'Arbitrum Sepolia',
        logRangeCap: 5000,
        waits: { creditSecs: 1200, finalizedSecs: 1800 },
      }),
    );
    expect(CHAINS.BASE_MAINNET).toEqual(
      chain({
        slug: 'base',
        network: 'mainnet',
        caip2: 'eip155:8453',
        evmChainId: 8453,
        rpcUrls: ['https://mainnet.base.org'],
        explorerTx: 'https://basescan.org/tx/{tx}',
        chainName: 'Base',
        logRangeCap: 1000,
        l1FeeOracle: ORACLE,
        waits: { creditSecs: 300, finalizedSecs: 1800 },
      }),
    );
    expect(CHAINS.BASE_DEVNET).toEqual(
      chain({
        slug: 'base',
        network: 'devnet',
        caip2: 'eip155:84532',
        evmChainId: 84532,
        rpcUrls: ['https://sepolia.base.org'],
        explorerTx: 'https://sepolia.basescan.org/tx/{tx}',
        chainName: 'Base Sepolia',
        logRangeCap: 1000,
        l1FeeOracle: ORACLE,
        waits: { creditSecs: 300, finalizedSecs: 3000 },
      }),
    );
  });

  it('pins each eip3009 USDC asset whole: 6 decimals, the on-chain domain and implementation', () => {
    const usdc = (fields: Record<string, unknown>): Record<string, unknown> => ({
      token: 'usdc',
      decimals: 6,
      symbol: 'USDC',
      ...fields,
    });
    expect(USDC_ETHEREUM_MAINNET).toEqual(
      usdc({
        chain: 'ethereum',
        mint: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        eip712: { name: 'USD Coin', version: '2' },
        implementation: '0x43506849d7c04f9138d1a2050bbf3a0c054402dd',
      }),
    );
    expect(USDC_ETHEREUM_DEVNET).toEqual(
      usdc({
        chain: 'ethereum',
        mint: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        eip712: { name: 'USDC', version: '2' },
        implementation: '0xda317c1d3e835dd5f1be459006471acaa1289068',
      }),
    );
    expect(USDC_ARBITRUM_MAINNET).toEqual(
      usdc({
        chain: 'arbitrum',
        mint: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        eip712: { name: 'USD Coin', version: '2' },
        implementation: '0x86e721b43d4ecfa71119dd38c0f938a75fdb57b3',
      }),
    );
    expect(USDC_ARBITRUM_DEVNET).toEqual(
      usdc({
        chain: 'arbitrum',
        mint: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
        eip712: { name: 'USD Coin', version: '2' },
        implementation: '0xfbb8ee011af0f15ee171e79c0688d05a58f7f566',
      }),
    );
    expect(USDC_BASE_MAINNET).toEqual(
      usdc({
        chain: 'base',
        mint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        eip712: { name: 'USD Coin', version: '2' },
        implementation: '0x2ce6311ddae708829bc0784c967b7d77d19fd779',
      }),
    );
    expect(USDC_BASE_DEVNET).toEqual(
      usdc({
        chain: 'base',
        mint: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        eip712: { name: 'USDC', version: '2' },
        implementation: '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5',
      }),
    );
  });
});
