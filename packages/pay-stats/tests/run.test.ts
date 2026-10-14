import { PROTOCOL_PROGRAM_ID_MAINNET, chainFor } from '@elisym/pay-core';
import { type Address, type Rpc, type SolanaRpcApi, address, none } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { getConfigEncoder } from '../../config-client/src/index';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import { fakeTempoChain, invalidRangeError } from '../../pay-core/tests/tempo-chain';
import {
  EXIT_ERROR,
  EXIT_INCOMPLETE,
  EXIT_OK,
  MARKER_LAUNCH,
  type RunDeps,
  main,
  parseOptions,
  redactUrls,
} from '../src/run';
import { dayStart } from '../src/tempo-days';

const SECRET_URL = 'https://rpc.example.com/v1/secret-path?api-key=SECRET-KEY';
const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const EVM_TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const SOLANA_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKED_MEMO = `0xfab22e7e${'01'.repeat(28)}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const LAUNCH = dayStart(MARKER_LAUNCH.mainnet);
const GENESIS_TIME = LAUNCH - 1000;
const HEAD_TIME = LAUNCH + 2 * 3600 + 600;
const HEAD = (HEAD_TIME - GENESIS_TIME) * 2;

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/** Two blocks a second from genesis, up to the head. */
function timestamps(): Record<number, number> {
  return new Proxy({} as Record<number, number>, {
    get: (_target, property) => {
      const number = Number(property);
      return Number.isInteger(number) && number >= 0 && number <= HEAD
        ? GENESIS_TIME + Math.floor(number / 2)
        : undefined;
    },
  });
}

/** A Solana mainnet node with no tagged transaction, and no fee config to read. */
const EMPTY_SOLANA = {
  getGenesisHash: () => ({ send: async () => MAINNET_GENESIS }),
  getSignaturesForAddress: () => ({ send: async () => [] }),
} as unknown as Rpc<SolanaRpcApi>;

function evmBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * A Solana node on `genesis` with no tagged transaction, serving a config
 * account at 100 bps with both treasuries set at whatever address is asked.
 */
function solanaWithConfig(genesis: string): Rpc<SolanaRpcApi> {
  const data = getConfigEncoder().encode({
    version: 1,
    bump: 254,
    admin: address(SOLANA_TREASURY),
    pendingAdmin: none(),
    treasury: address(SOLANA_TREASURY),
    feeBps: 100,
    paused: false,
    lastUpdated: 1_700_000_000n,
    evmTreasury: evmBytes(EVM_TREASURY),
    reserved: new Uint8Array(108),
  });
  const node = {
    getGenesisHash: () => ({ send: async () => genesis }),
    getSignaturesForAddress: () => ({ send: async () => [] }),
    getAccountInfo: (_address: Address) => ({
      send: async () => ({
        context: { slot: 1n },
        value: {
          data: [Buffer.from(data).toString('base64'), 'base64'],
          executable: false,
          lamports: 1_000_000n,
          owner: PROTOCOL_PROGRAM_ID_MAINNET,
          space: BigInt(data.length),
          rentEpoch: 0n,
        },
      }),
    }),
  };
  return node as unknown as Rpc<SolanaRpcApi>;
}

function deps(tempo: ReturnType<typeof fakeTempoChain>, env: Record<string, string> = {}) {
  const out = { printed: [] as string[], warned: [] as string[] };
  const runDeps: RunDeps & { print: (text: string) => void } = {
    solanaRpc: () => EMPTY_SOLANA,
    tempoClient: () => tempo.client,
    env: { ELISYM_STATS_SOLANA_RPC_URL: SECRET_URL, ...env },
    now: () => HEAD_TIME,
    warn: (line) => out.warned.push(line),
    print: (text) => out.printed.push(text),
  };
  return { runDeps, out };
}

/** A marked USDC.e transfer in the launch day's first hour. */
function markedLog(to: string, amount: bigint, logIndex: number) {
  return {
    address: USDCE,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(to)}`, MARKED_MEMO],
    data: `0x${word(amount)}`,
    blockNumber: (LAUNCH + 600 - GENESIS_TIME) * 2,
    transactionHash: TX_HASH,
    logIndex,
  };
}

function chainWith(options: Parameters<typeof fakeTempoChain>[0] = {}) {
  return fakeTempoChain({
    chainId: '0x1079',
    finalized: HEAD,
    timestamps: timestamps(),
    logs: [markedLog(PAYOUT, 49_000_000n, 0)],
    ...options,
  });
}

describe('the command line', () => {
  it('reads its flags', () => {
    expect(
      parseOptions([
        '--network',
        'devnet',
        '--since',
        '2026-10-20',
        '--until',
        '2026-10-21',
        '--format',
        'json',
        '--treasury',
        '0x90F79BF6EB2C4F870365E785982E1F101E93B906',
        '--treasury',
        'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      ]),
    ).toEqual({
      network: 'devnet',
      window: { since: '2026-10-20', until: '2026-10-21' },
      format: 'json',
      treasuries: [
        '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      ],
    });
    expect(() => parseOptions(['--since', '2026-13-45'])).toThrow('YYYY-MM-DD');
    expect(() => parseOptions(['--network', 'testnet'])).toThrow('mainnet or devnet');
    expect(() => parseOptions(['--rpc', 'x'])).toThrow('unknown argument');
  });

  it('cuts every URL to its host', () => {
    expect(redactUrls(`fetch ${SECRET_URL} failed`)).toBe('fetch https://rpc.example.com failed');
    expect(redactUrls('wss://user:pass@relay.example/x?k=1 down')).toBe('wss://relay.example down');
    expect(redactUrls('no url here')).toBe('no url here');
  });

  it('prints the purchases of a complete run and exits 0', async () => {
    const { runDeps, out } = deps(chainWith());
    expect(await main([], runDeps)).toBe(EXIT_OK);
    const printed = out.printed.join('\n');
    expect(printed).toContain(
      `${MARKER_LAUNCH.mainnet},tempo,mainnet,USDC.e,${PAYOUT},1,49000000,49,49000000,0,0,0`,
    );
    expect(printed).toContain('# fees');
    expect(printed).toContain(`${MARKER_LAUNCH.mainnet},tempo,partial_day,1`);
    expect(printed).toContain(`${MARKER_LAUNCH.mainnet},solana,partial_day,1`);
    // The fee config could not be read: said, without the URL.
    expect(out.warned.join('\n')).toMatch(/fee terms could not be read/);
    expect(`${printed}\n${out.warned.join('\n')}`).not.toContain('SECRET');
  });

  it('counts a leg to the on-chain config treasury as a fee', async () => {
    const { runDeps, out } = deps(
      chainWith({
        logs: [markedLog(PAYOUT, 49_000_000n, 0), markedLog(EVM_TREASURY, 490_000n, 1)],
      }),
    );
    runDeps.solanaRpc = () => solanaWithConfig(MAINNET_GENESIS);
    expect(await main([], runDeps)).toBe(EXIT_OK);
    const printed = out.printed.join('\n');
    expect(printed).toContain(
      `${MARKER_LAUNCH.mainnet},tempo,mainnet,USDC.e,${PAYOUT},1,49490000,49.49,49000000,490000,0,0`,
    );
    expect(printed).toContain(
      `${MARKER_LAUNCH.mainnet},tempo,mainnet,USDC.e,${EVM_TREASURY},1,490000,0.49`,
    );
    expect(out.warned).toEqual([]);
  });

  it.each([
    ['another cluster', DEVNET_GENESIS],
    ['no genesis hash', null],
  ])('refuses a Solana rpc that answers %s, scanning nothing', async (_label, genesis) => {
    const { runDeps, out } = deps(chainWith());
    const node = solanaWithConfig(MAINNET_GENESIS);
    runDeps.solanaRpc = () =>
      ({
        ...node,
        getGenesisHash: () => ({ send: async () => genesis }),
      }) as unknown as Rpc<SolanaRpcApi>;
    expect(await main([], runDeps)).toBe(EXIT_ERROR);
    expect(out.printed).toEqual([]);
    const warned = out.warned.join('\n');
    expect(warned).toContain(
      'the Solana rpc https://rpc.example.com does not serve Solana mainnet',
    );
    expect(warned).not.toContain('SECRET');
  });

  it('refuses a Solana rpc that cannot say its cluster, reading nothing more', async () => {
    const { runDeps, out } = deps(chainWith());
    const asked: string[] = [];
    const node = {
      getGenesisHash: () => ({
        send: async () => {
          asked.push('getGenesisHash');
          throw new Error(`getGenesisHash failed at ${SECRET_URL}`);
        },
      }),
      getSignaturesForAddress: () => ({
        send: async () => {
          asked.push('getSignaturesForAddress');
          return [];
        },
      }),
    };
    runDeps.solanaRpc = () => node as unknown as Rpc<SolanaRpcApi>;
    expect(await main([], runDeps)).toBe(EXIT_ERROR);
    expect(out.printed).toEqual([]);
    expect(asked).toEqual(['getGenesisHash']);
    const warned = out.warned.join('\n');
    expect(warned).toContain(
      'the Solana rpc https://rpc.example.com did not answer getGenesisHash',
    );
    expect(warned).not.toContain('SECRET');
  });

  it('refuses a Solana rpc that names another cluster to the fee read', async () => {
    const { runDeps, out } = deps(chainWith());
    const answers = [MAINNET_GENESIS, DEVNET_GENESIS];
    const node = solanaWithConfig(MAINNET_GENESIS);
    runDeps.solanaRpc = () =>
      ({
        ...node,
        getGenesisHash: () => ({ send: async () => answers.shift() ?? DEVNET_GENESIS }),
      }) as unknown as Rpc<SolanaRpcApi>;
    expect(await main([], runDeps)).toBe(EXIT_ERROR);
    expect(out.printed).toEqual([]);
    expect(out.warned.join('\n')).toContain(
      'ELISYM_STATS_SOLANA_RPC_URL does not serve Solana mainnet',
    );
  });

  it('refuses a Tempo rpc that cannot say its chain, scanning nothing', async () => {
    const tempo = chainWith();
    const { runDeps, out } = deps(tempo, {
      ELISYM_STATS_TEMPO_RPC_URL: 'https://tempo.example.com/secret?key=SECRET-TEMPO',
    });
    runDeps.tempoClient = () => ({
      request: async (call) => {
        if (call.method === 'eth_chainId') {
          throw new Error('eth_chainId failed');
        }
        return tempo.client.request(call);
      },
    });
    expect(await main([], runDeps)).toBe(EXIT_ERROR);
    expect(out.printed).toEqual([]);
    expect(tempo.getLogsCalls).toEqual([]);
    const warned = out.warned.join('\n');
    expect(warned).toContain('https://tempo.example.com did not answer eth_chainId');
    expect(warned).not.toContain('SECRET');
  });

  it('refuses a Tempo rpc on another chain, scanning nothing', async () => {
    const { runDeps, out } = deps(chainWith({ chainId: '0xa5bf' }), {
      ELISYM_STATS_TEMPO_RPC_URL: 'https://tempo.example.com/secret?key=SECRET-TEMPO',
    });
    expect(await main([], runDeps)).toBe(EXIT_ERROR);
    expect(out.printed).toEqual([]);
    const warned = out.warned.join('\n');
    expect(warned).toContain('https://tempo.example.com does not serve Tempo mainnet');
    expect(warned).not.toContain('SECRET');
  });

  it.each([
    ['an override', 'https://tempo.example.com/key', 'https://tempo.example.com/key'],
    ['an empty value as unset', '', chainFor('tempo', 'mainnet').rpcUrls[0]],
  ])('reads the Tempo rpc from the environment, %s', async (_label, value, expected) => {
    const { runDeps } = deps(chainWith(), { ELISYM_STATS_TEMPO_RPC_URL: value });
    const asked: string[] = [];
    const client = runDeps.tempoClient('');
    runDeps.tempoClient = (url) => {
      asked.push(url);
      return client;
    };
    expect(await main([], runDeps)).toBe(EXIT_OK);
    expect(asked).toEqual([expected]);
  });

  it('exits non-zero when an hour stays incomplete, still printing what it read', async () => {
    const { runDeps, out } = deps(chainWith({ onGetLogs: () => invalidRangeError() }));
    expect(await main(['--format', 'json'], runDeps)).toBe(EXIT_INCOMPLETE);
    const report = JSON.parse(out.printed.join('')) as {
      complete: boolean;
      context: { bucket: string }[];
    };
    expect(report.complete).toBe(false);
    expect(report.context.some((row) => row.bucket === 'incomplete_hours')).toBe(true);
  });

  it('prints an error with no URL in it, and refuses to run without a Solana RPC', async () => {
    const failing = deps(chainWith());
    failing.runDeps.solanaRpc = () => {
      throw new Error(`cannot reach ${SECRET_URL}`);
    };
    expect(await main([], failing.runDeps)).toBe(EXIT_ERROR);
    expect(failing.out.warned.join('\n')).toContain('https://rpc.example.com');
    expect(failing.out.warned.join('\n')).not.toContain('SECRET');

    const unset = deps(chainWith());
    unset.runDeps.env = {};
    expect(await main([], unset.runDeps)).toBe(EXIT_ERROR);
    expect(unset.out.warned.join('\n')).toMatch(/ELISYM_STATS_SOLANA_RPC_URL/);
  });
});
