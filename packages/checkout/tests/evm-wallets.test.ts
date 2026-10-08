import { tempoWalletCanBatch } from '@elisym/commerce/buyer';
import { chainByCaip2 } from '@elisym/pay-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Eip1193Provider,
  type Eip6963Wallet,
  TEMPO_UNSUPPORTED_RDNS,
  TempoChainUnsupported,
  WALLET_READ_TIMEOUT_MS,
  WalletReadTimeout,
  bundleStatusReader,
  connectTempo,
  readAtomicCapability,
  readCallsStatus,
  sendAtomicCalls,
  discoverEvmWallets,
  tempoWalletOptions,
} from '../src/app/evm-wallets';

const MODERATO = chainByCaip2('eip155:42431');
if (MODERATO === undefined) {
  throw new Error('the registry names Moderato');
}
const CHAIN = MODERATO;
const ACCOUNT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

/** A wallet error as providers throw them. */
function failure(code: number, message = 'error', data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** A provider that answers each method from `answers` (an Error is thrown), recording calls. */
function provider(answers: Record<string, unknown>): Eip1193Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method }) {
      calls.push(method);
      const answer = method in answers ? answers[method] : null;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

function wallet(name: string, rdns?: string): Eip6963Wallet {
  return {
    info: { uuid: name, name, ...(rdns === undefined ? {} : { rdns }) },
    provider: provider({}),
  };
}

describe('the Tempo wallet list', () => {
  it('leaves out wallets that cannot add a custom chain, and keeps the rest', () => {
    expect(TEMPO_UNSUPPORTED_RDNS).toContain('app.phantom');
    const names = tempoWalletOptions(
      [wallet('Phantom', 'app.phantom'), wallet('MetaMask', 'io.metamask'), wallet('Unnamed')],
      CHAIN,
    ).map((option) => option.name);
    expect(names).toEqual(['MetaMask', 'Unnamed']);
  });

  it('carries the announced rdns through discovery', () => {
    const target = new EventTarget() as unknown as Window;
    const found = discoverEvmWallets(target);
    target.dispatchEvent(
      Object.assign(new Event('eip6963:announceProvider'), {
        detail: {
          info: {
            uuid: 'u1',
            name: 'Phantom',
            rdns: 'app.phantom',
            icon: 'data:image/png;base64,',
          },
          provider: provider({}),
        },
      }),
    );
    expect(found.list()[0]?.info.rdns).toBe('app.phantom');
  });
});

describe('connecting a Tempo wallet', () => {
  for (const [code, message] of [
    [4200, 'Unsupported method'],
    [-32601, 'Method not found'],
    [-32603, 'This chain is not supported'],
  ] as const) {
    it(`names a wallet that cannot switch (${code})`, async () => {
      const wallet = provider({
        eth_requestAccounts: [ACCOUNT],
        wallet_switchEthereumChain: failure(code, message),
      });
      await expect(connectTempo(wallet, CHAIN)).rejects.toBeInstanceOf(TempoChainUnsupported);
    });
  }

  it('adds an unknown chain, then uses it', async () => {
    const wallet = provider({
      eth_requestAccounts: [ACCOUNT],
      wallet_switchEthereumChain: failure(4902, 'Unrecognized chain ID'),
    });
    await expect(connectTempo(wallet, CHAIN)).resolves.toMatchObject({ address: ACCOUNT });
    expect(wallet.calls).toContain('wallet_addEthereumChain');
  });

  it('adds an unknown chain reported as -32603 with the message, or with 4902 nested', async () => {
    for (const error of [
      failure(
        -32603,
        'Unrecognized chain ID "0xa5bf". Try adding the chain using wallet_addEthereumChain first.',
      ),
      failure(-32603, 'Internal error', { originalError: { code: 4902 } }),
    ]) {
      const wallet = provider({
        eth_requestAccounts: [ACCOUNT],
        wallet_switchEthereumChain: error,
      });
      await expect(connectTempo(wallet, CHAIN)).resolves.toMatchObject({ address: ACCOUNT });
    }
  });

  it('names a wallet that cannot add the chain, but not one whose add failed otherwise', async () => {
    const unsupported = provider({
      eth_requestAccounts: [ACCOUNT],
      wallet_switchEthereumChain: failure(4902),
      wallet_addEthereumChain: failure(4200, 'Unsupported method'),
    });
    await expect(connectTempo(unsupported, CHAIN)).rejects.toBeInstanceOf(TempoChainUnsupported);
    const unreachable = provider({
      eth_requestAccounts: [ACCOUNT],
      wallet_switchEthereumChain: failure(4902),
      wallet_addEthereumChain: failure(-32603, 'Could not fetch chain ID'),
    });
    const outcome = await connectTempo(unreachable, CHAIN).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(TempoChainUnsupported);
  });

  it('passes a refusal or a busy wallet through as they are', async () => {
    for (const [method, code] of [
      ['eth_requestAccounts', 4001],
      ['wallet_switchEthereumChain', 4001],
      ['wallet_switchEthereumChain', -32002],
    ] as const) {
      const wallet = provider({ eth_requestAccounts: [ACCOUNT], [method]: failure(code) });
      const outcome = await connectTempo(wallet, CHAIN).catch((error: unknown) => error);
      expect(outcome).not.toBeInstanceOf(TempoChainUnsupported);
      expect(outcome).toMatchObject({ code });
    }
  });
});

/** A provider that records every request with its params and answers from `answer`. */
function recording(answer: (method: string, params: unknown) => unknown) {
  const requests: { method: string; params: unknown }[] = [];
  const target: Eip1193Provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      const value = answer(method, params);
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  };
  return { provider: target, requests };
}

describe('EIP-5792: batching on Tempo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads atomic batching for the account and the chain: ready and supported only', async () => {
    for (const [status, atomic] of [
      ['ready', true],
      ['supported', true],
      ['unsupported', false],
    ] as const) {
      const wallet = recording(() => ({ '0xa5bf': { atomic: { status } } }));
      expect(await readAtomicCapability(wallet.provider, ACCOUNT, '0xa5bf')).toBe(atomic);
      expect(wallet.requests).toEqual([
        { method: 'wallet_getCapabilities', params: [ACCOUNT, ['0xa5bf']] },
      ]);
    }
    const otherChain = recording(() => ({ '0x1079': { atomic: { status: 'ready' } } }));
    expect(await readAtomicCapability(otherChain.provider, ACCOUNT, '0xa5bf')).toBe(false);
  });

  it('gives up on a capabilities read that never answers', async () => {
    vi.useFakeTimers();
    const silent: Eip1193Provider = { request: () => new Promise(() => undefined) };
    const read = readAtomicCapability(silent, ACCOUNT, '0xa5bf');
    const caught = read.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS);
    expect(await caught).toBeInstanceOf(WalletReadTimeout);
  });

  it('sends both legs as one atomic batch and returns the bundle id', async () => {
    const wallet = recording(() => ({ id: 'bundle-1' }));
    const calls = [
      { to: '0x20c0000000000000000000000000000000000000', data: '0x01' },
      { to: '0x20c0000000000000000000000000000000000000', data: '0x02' },
    ];
    expect(
      await sendAtomicCalls(wallet.provider, { from: ACCOUNT, chainId: '0xa5bf', calls }),
    ).toEqual({ bundleId: 'bundle-1' });
    expect(wallet.requests).toEqual([
      {
        method: 'wallet_sendCalls',
        params: [
          {
            version: '2.0.0',
            from: ACCOUNT,
            chainId: '0xa5bf',
            atomicRequired: true,
            calls: calls.map((call) => ({ ...call, value: '0x0' })),
          },
        ],
      },
    ]);
    const older = recording(() => 'bundle-2');
    expect(
      await sendAtomicCalls(older.provider, { from: ACCOUNT, chainId: '0xa5bf', calls }),
    ).toEqual({ bundleId: 'bundle-2' });
    const nothing = recording(() => ({}));
    await expect(
      sendAtomicCalls(nothing.provider, { from: ACCOUNT, chainId: '0xa5bf', calls }),
    ).rejects.toThrow();
  });

  it('reads a bundle status, and refuses an answer with no numeric status', async () => {
    const wallet = recording(() => ({
      status: 200,
      atomic: true,
      receipts: [{ transactionHash: '0xab', logs: [] }],
    }));
    expect(await readCallsStatus(wallet.provider, 'bundle-1')).toEqual({
      status: 200,
      atomic: true,
      receipts: [{ transactionHash: '0xab' }],
    });
    expect(wallet.requests).toEqual([{ method: 'wallet_getCallsStatus', params: ['bundle-1'] }]);
    const words = recording(() => ({ status: 'CONFIRMED' }));
    await expect(readCallsStatus(words.provider, 'bundle-1')).rejects.toThrow();
  });

  it('gives up on a status read that never answers within 5 s', async () => {
    expect(WALLET_READ_TIMEOUT_MS).toBe(5_000);
    vi.useFakeTimers();
    const silent: Eip1193Provider = { request: () => new Promise(() => undefined) };
    const caught = readCallsStatus(silent, 'bundle-1').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS - 1);
    let settled = false;
    void caught.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toBeInstanceOf(WalletReadTimeout);
  });

  it('asks a discovered wallet about a bundle without connecting it', async () => {
    const wallet = recording(() => ({ status: 100 }));
    const found: Eip6963Wallet[] = [
      { info: { uuid: 'u', name: 'MetaMask', rdns: 'io.metamask' }, provider: wallet.provider },
    ];
    expect(bundleStatusReader(found, 'app.other')).toBeUndefined();
    expect(bundleStatusReader(found, undefined)).toBeUndefined();
    const reader = bundleStatusReader(found, 'io.metamask');
    expect(await reader?.callsStatus?.('bundle-1')).toEqual({ status: 100 });
    expect(wallet.requests.map((request) => request.method)).toEqual(['wallet_getCallsStatus']);
  });

  it('connects with the batching methods and the rdns', async () => {
    const wallet = recording((method) => {
      if (method === 'eth_requestAccounts') {
        return [ACCOUNT];
      }
      if (method === 'wallet_getCapabilities') {
        return { '0xa5bf': { atomic: { status: 'ready' } } };
      }
      return null;
    });
    const connected = await connectTempo(wallet.provider, CHAIN, 'io.metamask');
    expect(connected.rdns).toBe('io.metamask');
    expect(await connected.capabilities?.('0xa5bf')).toEqual({ atomic: true });
    const option = tempoWalletOptions(
      [{ info: { uuid: 'u', name: 'MetaMask', rdns: 'io.metamask' }, provider: wallet.provider }],
      CHAIN,
    )[0];
    expect(option?.rdns).toBe('io.metamask');
    // The wallet it connects names its rdns too: a bundle it approves records it.
    expect((await option?.connect())?.rdns).toBe('io.metamask');
  });

  it('connects a wallet that cannot batch as one: unsupported, or a capabilities read that fails', async () => {
    const unsupported = recording((method) => {
      if (method === 'eth_requestAccounts') {
        return [ACCOUNT];
      }
      if (method === 'wallet_getCapabilities') {
        return { '0xa5bf': { atomic: { status: 'unsupported' } } };
      }
      return null;
    });
    const plain = await connectTempo(unsupported.provider, CHAIN, 'io.metamask');
    expect(await plain.capabilities?.('0xa5bf')).toEqual({ atomic: false });
    expect(await tempoWalletCanBatch(plain, '0xa5bf')).toBe(false);
    const failing = recording((method) => {
      if (method === 'eth_requestAccounts') {
        return [ACCOUNT];
      }
      if (method === 'wallet_getCapabilities') {
        return failure(-32601, 'method not found');
      }
      return null;
    });
    const broken = await connectTempo(failing.provider, CHAIN, 'io.metamask');
    expect(await tempoWalletCanBatch(broken, '0xa5bf')).toBe(false);
    expect(failing.requests.map((request) => request.method)).toContain('wallet_getCapabilities');
  });
});
