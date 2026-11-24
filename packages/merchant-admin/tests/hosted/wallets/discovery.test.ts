import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchWallets, type WalletChoice } from '../../../src/hosted/lib/wallets';
import {
  announceEvmWallet,
  fakeEvmProvider,
  fakeSolanaWallet,
  injectStandardWallet,
} from './fakes';

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function track(remove: () => void): void {
  cleanups.push(remove);
}

function lastList(onChange: ReturnType<typeof vi.fn>): WalletChoice[] {
  const calls = onChange.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? []) as WalletChoice[];
}

describe('watchWallets - solana (Wallet Standard)', () => {
  it('offers wallets that registered before and after, only those with solana:signMessage on a solana chain', () => {
    track(injectStandardWallet(window, fakeSolanaWallet({ name: 'Early', icon: ICON })));
    track(
      injectStandardWallet(window, fakeSolanaWallet({ name: 'NoSign', withSignMessage: false })),
    );
    const noConnect = fakeSolanaWallet({ name: 'NoConnect' });
    delete noConnect.features['standard:connect'];
    track(injectStandardWallet(window, noConnect));
    track(
      injectStandardWallet(
        window,
        fakeSolanaWallet({ name: 'OtherChain', chains: ['sui:mainnet'] }),
      ),
    );
    const onChange = vi.fn();
    const stop = watchWallets('solana', onChange);
    track(stop);
    expect(lastList(onChange)).toEqual([
      { id: expect.stringMatching(/^solana:/), name: 'Early', icon: ICON, family: 'solana' },
    ]);

    track(
      injectStandardWallet(
        window,
        fakeSolanaWallet({ name: 'Late', icon: 'https://x.test/i.png' }),
      ),
    );
    const list = lastList(onChange);
    expect(list.map((choice) => choice.name)).toEqual(['Early', 'Late']);
    expect(list[1]?.icon).toBeUndefined();
    expect(new Set(list.map((choice) => choice.id)).size).toBe(2);
  });

  it('registers one wallet once, with a stable id across watchers', () => {
    const wallet = fakeSolanaWallet({ name: 'Once' });
    track(injectStandardWallet(window, wallet));
    const first = vi.fn();
    track(watchWallets('solana', first));
    track(injectStandardWallet(window, wallet));
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn();
    track(watchWallets('solana', second));
    expect(lastList(second)[0]?.id).toBe(lastList(first)[0]?.id);
  });

  it('stops listening once stopped', () => {
    const onChange = vi.fn();
    const stop = watchWallets('solana', onChange);
    stop();
    track(injectStandardWallet(window, fakeSolanaWallet({ name: 'After stop' })));
    const registerCallback = vi.fn();
    window.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', { detail: registerCallback }),
    );
    expect(registerCallback).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a wallet that registers through the app-ready registry after the stop is not offered', () => {
    let registry: { register: (...wallets: unknown[]) => unknown } | undefined;
    const keepRegistry = (event: Event) => {
      registry = (event as CustomEvent<typeof registry>).detail;
    };
    window.addEventListener('wallet-standard:app-ready', keepRegistry);
    track(() => window.removeEventListener('wallet-standard:app-ready', keepRegistry));
    const onChange = vi.fn();
    const stop = watchWallets('solana', onChange);
    stop();
    registry?.register(fakeSolanaWallet({ name: 'Slow' }));
    expect(registry).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a wallet whose register throws is simply skipped', () => {
    const onChange = vi.fn();
    track(watchWallets('solana', onChange));
    window.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: () => {
          throw new Error('broken wallet');
        },
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('watchWallets - evm (EIP-6963)', () => {
  it('asks for providers and takes later announcements, each uuid once', () => {
    track(announceEvmWallet(window, { uuid: 'u-1', name: 'First', icon: ICON }, fakeEvmProvider()));
    const onChange = vi.fn();
    track(watchWallets('evm', onChange));
    expect(lastList(onChange)).toEqual([
      { id: 'evm:u-1', name: 'First', icon: ICON, family: 'evm' },
    ]);

    track(
      announceEvmWallet(
        window,
        { uuid: 'u-2', name: 'Second', icon: 'https://x.test/i.png' },
        fakeEvmProvider(),
      ),
    );
    track(announceEvmWallet(window, { uuid: 'u-1', name: 'Again' }, fakeEvmProvider()));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(lastList(onChange)).toEqual([
      { id: 'evm:u-1', name: 'First', icon: ICON, family: 'evm' },
      { id: 'evm:u-2', name: 'Second', icon: undefined, family: 'evm' },
    ]);
  });

  it('ignores malformed announcements', () => {
    const onChange = vi.fn();
    track(watchWallets('evm', onChange));
    track(announceEvmWallet(window, { uuid: 'no-provider', name: 'X' }, undefined));
    track(announceEvmWallet(window, { uuid: 'no-request', name: 'X' }, { request: 'nope' }));
    track(
      announceEvmWallet(
        window,
        { uuid: 7, name: 'X' } as unknown as { uuid: string; name: string },
        fakeEvmProvider(),
      ),
    );
    track(
      announceEvmWallet(
        window,
        { uuid: 'no-name' } as unknown as { uuid: string; name: string },
        fakeEvmProvider(),
      ),
    );
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: undefined }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops listening once stopped, and the families stay apart', () => {
    const evm = vi.fn();
    const solana = vi.fn();
    watchWallets('evm', evm)();
    track(watchWallets('solana', solana));
    track(announceEvmWallet(window, { uuid: 'after-stop', name: 'Late' }, fakeEvmProvider()));
    expect(evm).not.toHaveBeenCalled();
    expect(solana).not.toHaveBeenCalled();
  });

  it('reads the page window by default and a given target otherwise', () => {
    const target = new EventTarget() as unknown as Window;
    const onChange = vi.fn();
    track(watchWallets('evm', onChange, target));
    track(announceEvmWallet(window, { uuid: 'window-only', name: 'W' }, fakeEvmProvider()));
    expect(onChange).not.toHaveBeenCalled();
    track(announceEvmWallet(target, { uuid: 'target', name: 'T' }, fakeEvmProvider()));
    expect(lastList(onChange).map((choice) => choice.id)).toEqual(['evm:target']);
  });
});
