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
  /** The wallet's reverse-DNS id (`io.metamask`, `app.phantom`), when it says. */
  rdns?: string;
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

/**
 * Wallets whose EVM provider cannot add or switch to a custom chain such as
 * Tempo: they are not offered there. Extend by rdns as more are found.
 */
export const TEMPO_UNSUPPORTED_RDNS: readonly string[] = ['app.phantom'];

/** The wallet cannot pay on the Tempo chain: it refused to add or switch to it. */
export class TempoChainUnsupported extends Error {
  constructor() {
    super('this wallet cannot use the Tempo chain');
    this.name = 'TempoChainUnsupported';
  }
}

/** A field of an error-like object, if it has one. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A wallet error code (EIP-1193): 4001 a user refusal, 4902 an unknown chain, -32002 busy. */
export function errorCode(error: unknown): number | undefined {
  const code = fieldOf(error, 'code');
  return code === undefined ? undefined : Number(code);
}

/** Some MetaMask builds (mobile) send the unknown chain as -32603, with 4902 nested. */
function nestedCode(error: unknown): number | undefined {
  return errorCode(fieldOf(fieldOf(error, 'data'), 'originalError'));
}

function messageOf(error: unknown): string {
  const message = fieldOf(error, 'message');
  return typeof message === 'string' ? message : '';
}

/** The buyer refused in the wallet. */
const REJECTED = 4001;
/** The wallet already has a request open (a press after a cancel, say). */
const BUSY = -32002;
/** The wallet does not know the chain: it is added, then used. */
const UNKNOWN_CHAIN = 4902;
/** Codes a wallet answers to a switch it does not do at all. */
const UNSUPPORTED_CODES: readonly number[] = [4200, -32601, -32602];
/** Codes a wallet answers to an add it does not do at all (-32602 there may be a bad RPC). */
const ADD_UNSUPPORTED_CODES: readonly number[] = [4200, -32601];

/** How a failed wallet request reads to the buyer: refused, busy, or anything else. */
export function walletErrorKind(error: unknown): 'rejected' | 'busy' | 'failed' {
  const code = errorCode(error);
  if (code === REJECTED) {
    return 'rejected';
  }
  return code === BUSY ? 'busy' : 'failed';
}

function unknownChain(error: unknown): boolean {
  return (
    errorCode(error) === UNKNOWN_CHAIN ||
    nestedCode(error) === UNKNOWN_CHAIN ||
    /unrecognized chain|unknown chain/i.test(messageOf(error))
  );
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
    const code = errorCode(error);
    if (code === REJECTED || code === BUSY) {
      throw error;
    }
    // An unknown chain is added first: only a wallet that cannot add one is unsupported.
    if (unknownChain(error)) {
      await addChain(provider, chain, chainId);
      return;
    }
    if (
      (code !== undefined && UNSUPPORTED_CODES.includes(code)) ||
      /unsupported|not supported/i.test(messageOf(error))
    ) {
      throw new TempoChainUnsupported();
    }
    throw error;
  }
}

async function addChain(
  provider: Eip1193Provider,
  chain: ChainConfig,
  chainId: string,
): Promise<void> {
  const explorer = chain.explorerTx?.split('/tx/')[0];
  try {
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
  } catch (error) {
    // Only a wallet that does not do this at all is unsupported: an unreachable
    // RPC or a refusal is not a reason to send the buyer to another wallet.
    const code = errorCode(error);
    if (
      (code !== undefined && ADD_UNSUPPORTED_CODES.includes(code)) ||
      /unsupported|not supported|not implemented/i.test(messageOf(error))
    ) {
      throw new TempoChainUnsupported();
    }
    throw error;
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
  return wallets
    .filter(
      (wallet) =>
        wallet.info.rdns === undefined || !TEMPO_UNSUPPORTED_RDNS.includes(wallet.info.rdns),
    )
    .map((wallet) => ({
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
    found.set(info.uuid, {
      info: {
        uuid: info.uuid,
        name: info.name,
        ...(typeof info.icon === 'string' ? { icon: info.icon } : {}),
        ...(typeof info.rdns === 'string' ? { rdns: info.rdns } : {}),
      },
      provider,
    });
    onChange();
  });
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return { list: () => [...found.values()] };
}
