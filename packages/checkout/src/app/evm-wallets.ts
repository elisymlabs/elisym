import type { TempoWallet } from '@elisym/commerce/buyer';
import type { ChainConfig } from '@elisym/pay-core';

/** An EIP-1193 provider, reduced to `request`. */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

/** What an EIP-6963 wallet announces about itself. */
export interface Eip6963Info {
  uuid: string;
  name: string;
  /** A data: URI image (anything else is not shown: the CSP allows only data: images). */
  icon?: string;
}

export interface Eip6963Wallet {
  info: Eip6963Info;
  provider: Eip1193Provider;
}

/** A Tempo wallet the checkout can offer: connecting it switches to the chain. */
export interface TempoWalletOption {
  name: string;
  icon?: string;
  connect(): Promise<TempoWallet>;
}

/** An EIP-1193 error code: 4001 is a user refusal, 4902 an unknown chain. */
function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code: unknown }).code)
    : undefined;
}

const HEX_CHAIN = (chainId: number) => `0x${chainId.toString(16)}`;

/**
 * Put the wallet on `chain`: switch, and add it from the registry when the
 * wallet does not know it (MetaMask needs `nativeCurrency.decimals` 18).
 */
async function switchTo(provider: Eip1193Provider, chain: ChainConfig): Promise<void> {
  if (chain.evmChainId === undefined) {
    throw new Error('not an EVM chain');
  }
  const chainId = HEX_CHAIN(chain.evmChainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (errorCode(error) !== 4902) {
      throw error;
    }
    const explorer = chain.explorerTx?.split('/tx/')[0];
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: chain.network === 'mainnet' ? 'Tempo' : 'Tempo Moderato',
          nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
          rpcUrls: [...chain.rpcUrls],
          ...(explorer === undefined ? {} : { blockExplorerUrls: [explorer] }),
        },
      ],
    });
  }
}

/** Connect: accounts first, then the chain - all before anything is composed or marked. */
export async function connectTempo(
  provider: Eip1193Provider,
  chain: ChainConfig,
): Promise<TempoWallet> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof address !== 'string') {
    throw new Error('the wallet has no account');
  }
  await switchTo(provider, chain);
  return {
    address: address.toLowerCase(),
    async chainId() {
      const answer = await provider.request({ method: 'eth_chainId' });
      return typeof answer === 'string' ? Number.parseInt(answer, 16) : Number.NaN;
    },
    async sendCall(call) {
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: call.from, to: call.to, data: call.data, chainId: call.chainId }],
      });
      if (typeof hash !== 'string') {
        throw new Error('the wallet returned no hash');
      }
      return hash;
    },
  };
}

export function tempoWalletOptions(
  wallets: readonly Eip6963Wallet[],
  chain: ChainConfig,
): TempoWalletOption[] {
  return wallets.map((wallet) => ({
    name: wallet.info.name,
    ...(wallet.info.icon?.startsWith('data:') === true ? { icon: wallet.info.icon } : {}),
    connect: () => connectTempo(wallet.provider, chain),
  }));
}

/**
 * Collect EIP-6963 wallets as they announce themselves: ask once, and take
 * every announcement (one per wallet, by uuid).
 */
export function discoverEvmWallets(
  target: Window,
  onChange: () => void = () => undefined,
): { list(): Eip6963Wallet[] } {
  const found = new Map<string, Eip6963Wallet>();
  target.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent<unknown>).detail as Partial<Eip6963Wallet> | undefined;
    const info = detail?.info;
    const provider = detail?.provider;
    if (
      info === undefined ||
      typeof info.uuid !== 'string' ||
      typeof info.name !== 'string' ||
      provider === undefined ||
      typeof provider.request !== 'function' ||
      found.has(info.uuid)
    ) {
      return;
    }
    found.set(info.uuid, { info, provider });
    onChange();
  });
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return { list: () => [...found.values()] };
}
