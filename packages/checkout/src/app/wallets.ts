import type { SolanaWallet } from '../core/solana-pay';
import type { WalletOption } from './session';

/** The part of a Wallet Standard wallet the checkout uses. */
export interface StandardWallet {
  name: string;
  icon?: string;
  chains: readonly string[];
  features: Record<string, unknown>;
}

interface StandardAccount {
  address: string;
  chains?: readonly string[];
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly StandardAccount[] }>;
}

interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

/** The Wallet Standard chain id of a Solana network. */
export function solanaChain(network: 'mainnet' | 'devnet'): string {
  return `solana:${network}`;
}

/**
 * Wallets that can pay on `chain` the way the checkout pays: `solana:signTransaction`
 * (the checkout sends the bytes itself, and never uses signAndSend, whose
 * lifetime and broadcast it could not control) and `standard:connect`.
 */
export function payingWallets(wallets: readonly StandardWallet[], chain: string): WalletOption[] {
  return wallets
    .filter(
      (wallet) =>
        wallet.chains.includes(chain) &&
        'solana:signTransaction' in wallet.features &&
        'standard:connect' in wallet.features,
    )
    .map((wallet) => ({
      name: wallet.name,
      ...(wallet.icon === undefined ? {} : { icon: wallet.icon }),
      connect: () => connect(wallet, chain),
    }));
}

async function connect(wallet: StandardWallet, chain: string): Promise<SolanaWallet> {
  const { accounts } = await (wallet.features['standard:connect'] as ConnectFeature).connect();
  const account = accounts.find(
    (candidate) => candidate.chains === undefined || candidate.chains.includes(chain),
  );
  if (account === undefined) {
    throw new Error('the wallet has no account on this network');
  }
  const feature = wallet.features['solana:signTransaction'] as SignTransactionFeature;
  return {
    address: account.address,
    async signTransaction(transaction) {
      const [result] = await feature.signTransaction({ account, transaction, chain });
      if (result === undefined) {
        throw new Error('the wallet returned nothing');
      }
      return result.signedTransaction;
    },
  };
}

/**
 * Collect Wallet Standard wallets as they register (the app-ready handshake of
 * the standard): wallets injected into this frame announce themselves here.
 */
export function discoverWallets(
  target: Window,
  onChange: () => void = () => undefined,
): { list(): StandardWallet[] } {
  const found: StandardWallet[] = [];
  const api = {
    register: (...wallets: StandardWallet[]) => {
      let added = false;
      for (const wallet of wallets) {
        if (!found.includes(wallet)) {
          found.push(wallet);
          added = true;
        }
      }
      if (added) {
        onChange();
      }
      return () => undefined;
    },
  };
  target.addEventListener('wallet-standard:register-wallet', (event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === 'function') {
      try {
        (callback as (registry: typeof api) => void)(api);
      } catch {
        // A wallet that fails to register is simply not offered.
      }
    }
  });
  target.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  return { list: () => [...found] };
}
