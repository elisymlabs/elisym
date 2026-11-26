import { parseCaip19 } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { metaView, servedCoins } from '../src/admin/meta';

const ALL_RPCS = {
  solana: 'https://sol.example/?api-key=secret',
  tempo: 'https://tempo.example',
  evm: {
    ethereum: 'https://eth.example',
    arbitrum: 'https://arb.example',
    base: 'https://base.example',
  },
};

describe('/v1/meta', () => {
  it('lists only USD coins of the rails with an operator RPC, each a coin the server parses', () => {
    const coins = servedCoins(ALL_RPCS, 'mainnet');
    expect(coins.length).toBeGreaterThan(0);
    for (const coin of coins) {
      const parsed = parseCaip19(coin);
      expect(parsed?.chain.network, coin).toBe('mainnet');
      expect(['usdc', 'usdce', 'pathusd'], coin).toContain(parsed?.asset.token);
    }
    // LSM is a Solana mainnet coin but no USD one: a USD price cannot be paid in it.
    expect(coins.some((coin) => parseCaip19(coin)?.asset.token === 'lsm')).toBe(false);
    expect(new Set(coins.map((coin) => parseCaip19(coin)?.chain.slug))).toEqual(
      new Set(['solana', 'tempo', 'ethereum', 'arbitrum', 'base']),
    );
    expect(servedCoins({ evm: {} }, 'mainnet')).toEqual([]);
    expect(
      servedCoins({ evm: { base: 'https://base.example' } }, 'devnet').map(
        (coin) => parseCaip19(coin)?.chain.slug,
      ),
    ).toEqual(['base']);
    // A fee RPC alone takes no payments.
    expect(servedCoins({ fee: 'https://fee.example', evm: {} }, 'devnet')).toEqual([]);
  });

  it('holds no RPC URL and the public base without a trailing slash', () => {
    const view = metaView(
      {
        publicBase: 'https://api.paycore.example/',
        operator: 'api.paycore.example',
        rpcs: { mainnet: ALL_RPCS, devnet: { evm: {} } },
        inboxRelays: ['wss://relay.elisym.network'],
        storeMoves: true,
      },
      20,
    );
    expect(view).toMatchObject({
      publicBase: 'https://api.paycore.example',
      operator: 'api.paycore.example',
      networks: { devnet: { coins: [] } },
      inboxRelays: ['wss://relay.elisym.network'],
      pendingMaxProducts: 20,
      storeMoves: true,
    });
    expect(JSON.stringify(view)).not.toMatch(/sol\.example|secret|tempo\.example|eth\.example/);
  });
});
