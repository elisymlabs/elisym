/**
 * Browser wallets this page can ask for a payout proof (A5). Copied from the
 * checkout (`checkout/src/app/wallets.ts`, `checkout/src/app/evm-wallets.ts`),
 * not imported: the admin needs message signing, the checkout transactions.
 *
 * A `WalletChoice` is plain data; the wallet object it names stays behind its
 * id in a module-private map, so nothing a screen holds can call a wallet.
 */

export type WalletFamily = 'solana' | 'evm';

export interface WalletChoice {
  id: string;
  name: string;
  family: WalletFamily;
}

/** The part of a Wallet Standard wallet a proof uses. */
export interface StandardWallet {
  name: string;
  chains: readonly string[];
  features: Record<string, unknown>;
}

/** An EIP-1193 provider, as EIP-6963 announces it. */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

export type KnownWallet =
  | { family: 'solana'; wallet: StandardWallet }
  | { family: 'evm'; provider: Eip1193Provider };

const KNOWN_WALLETS = new Map<string, KnownWallet>();
const SOLANA_IDS = new WeakMap<StandardWallet, string>();
let solanaCounter = 0;

/** The wallet behind a choice, or undefined when this page never offered it. */
export function knownWallet(choice: WalletChoice): KnownWallet | undefined {
  return KNOWN_WALLETS.get(choice.id);
}

function canSignMessages(wallet: StandardWallet): boolean {
  return (
    Array.isArray(wallet.chains) &&
    wallet.chains.some((chain) => typeof chain === 'string' && chain.startsWith('solana:')) &&
    typeof wallet.features === 'object' &&
    wallet.features !== null &&
    'standard:connect' in wallet.features &&
    'solana:signMessage' in wallet.features
  );
}

function solanaId(wallet: StandardWallet): string {
  const existing = SOLANA_IDS.get(wallet);
  if (existing !== undefined) {
    return existing;
  }
  solanaCounter += 1;
  const id = `solana:${solanaCounter}`;
  SOLANA_IDS.set(wallet, id);
  return id;
}

/**
 * Collect Wallet Standard wallets as they register (the app-ready handshake of
 * the standard), keeping those that can sign a message.
 */
function watchSolana(target: Window, onChange: (wallets: WalletChoice[]) => void): () => void {
  const found: WalletChoice[] = [];
  let stopped = false;
  const offerSolana = (wallet: StandardWallet): boolean => {
    if (stopped || !canSignMessages(wallet)) {
      return false;
    }
    const name = String(wallet.name);
    const id = solanaId(wallet);
    if (found.some((choice) => choice.id === id)) {
      return false;
    }
    KNOWN_WALLETS.set(id, { family: 'solana', wallet });
    found.push({ id, name, family: 'solana' });
    return true;
  };
  const api = {
    register: (...wallets: StandardWallet[]) => {
      let added = false;
      for (const wallet of wallets) {
        // A wallet whose getters throw is skipped alone: the others in the same call still count.
        try {
          added = offerSolana(wallet) || added;
        } catch {
          continue;
        }
      }
      if (added) {
        onChange([...found]);
      }
      return () => undefined;
    },
  };
  const listener = (event: Event): void => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === 'function') {
      try {
        (callback as (registry: typeof api) => void)(api);
      } catch {
        // A wallet that fails to register is simply not offered.
      }
    }
  };
  target.addEventListener('wallet-standard:register-wallet', listener);
  target.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  return () => {
    stopped = true;
    target.removeEventListener('wallet-standard:register-wallet', listener);
  };
}

interface Eip6963Detail {
  info?: { uuid?: unknown; name?: unknown };
  provider?: { request?: unknown };
}

/** Collect EIP-6963 wallets as they announce themselves: ask once, take each uuid once. */
function watchEvm(target: Window, onChange: (wallets: WalletChoice[]) => void): () => void {
  const found: WalletChoice[] = [];
  const offerEvm = (detail: Eip6963Detail | undefined): boolean => {
    const info = detail?.info;
    const provider = detail?.provider;
    const uuid = info?.uuid;
    const name = info?.name;
    if (
      typeof uuid !== 'string' ||
      typeof name !== 'string' ||
      provider === undefined ||
      typeof provider.request !== 'function'
    ) {
      return false;
    }
    const id = `evm:${uuid}`;
    if (found.some((choice) => choice.id === id)) {
      return false;
    }
    KNOWN_WALLETS.set(id, { family: 'evm', provider: provider as Eip1193Provider });
    found.push({ id, name, family: 'evm' });
    return true;
  };
  const listener = (event: Event): void => {
    let added = false;
    // An announcement whose getters throw is ignored.
    try {
      added = offerEvm((event as CustomEvent<unknown>).detail as Eip6963Detail | undefined);
    } catch {
      return;
    }
    if (added) {
      onChange([...found]);
    }
  };
  target.addEventListener('eip6963:announceProvider', listener);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => {
    target.removeEventListener('eip6963:announceProvider', listener);
  };
}

/**
 * Wallets injected in this page for `family` (wallet-standard for solana with
 * `solana:signMessage`; EIP-6963 for evm). Calls `onChange` as wallets
 * announce; returns a stop function.
 */
export function watchWallets(
  family: WalletFamily,
  onChange: (wallets: WalletChoice[]) => void,
  target: Window = window,
): () => void {
  return family === 'solana' ? watchSolana(target, onChange) : watchEvm(target, onChange);
}
