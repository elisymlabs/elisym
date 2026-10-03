import { chainByCaip2 } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import {
  type Eip1193Provider,
  type Eip6963Wallet,
  TEMPO_UNSUPPORTED_RDNS,
  TempoChainUnsupported,
  connectTempo,
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
