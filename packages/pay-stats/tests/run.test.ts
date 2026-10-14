import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it } from 'vitest';
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

/** A Solana node with no tagged transaction, and no fee config to read. */
const EMPTY_SOLANA = {
  getSignaturesForAddress: () => ({ send: async () => [] }),
} as unknown as Rpc<SolanaRpcApi>;

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

function chainWith(options: Parameters<typeof fakeTempoChain>[0] = {}) {
  const marked = `0xfab22e7e${'01'.repeat(28)}`;
  // A marked payment in the launch day's first hour.
  const block = (LAUNCH + 600 - GENESIS_TIME) * 2;
  return fakeTempoChain({
    chainId: '0x1079',
    finalized: HEAD,
    timestamps: timestamps(),
    logs: [
      {
        address: USDCE,
        topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYOUT)}`, marked],
        data: `0x${word(49_000_000n)}`,
        blockNumber: block,
        transactionHash: `0x${'ab'.repeat(32)}`,
        logIndex: 0,
      },
    ],
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
    // The fee config could not be read: said, without the URL.
    expect(out.warned.join('\n')).toMatch(/fee terms could not be read/);
    expect(`${printed}\n${out.warned.join('\n')}`).not.toContain('SECRET');
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
