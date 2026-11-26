import { eip191Hash } from '@elisym/commerce';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { getBase58Decoder } from '@solana/kit';

export const OWNER = 'a1'.repeat(32);
export const SOLANA_USDC_DEVNET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const BASE_USDC = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TEMPO_USDCE = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const BASE58 = getBase58Decoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  const clean = text.startsWith('0x') ? text.slice(2) : text;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** An ed25519 key pair with its Solana (base58) address. */
export function solanaKey(): { secretKey: Uint8Array; address: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, address: BASE58.decode(ed25519.getPublicKey(secretKey)) };
}

export function signEd25519(secretKey: Uint8Array, text: string): Uint8Array {
  return ed25519.sign(UTF8.encode(text), secretKey);
}

/** EIP-55 mixed-case spelling of a lowercase address. */
function checksummed(lower: string): string {
  const body = lower.slice(2);
  const digest = toHex(keccak_256(UTF8.encode(body)));
  const letters = Array.from(body, (character, index) =>
    Number.parseInt(digest.charAt(index), 16) >= 8 ? character.toUpperCase() : character,
  );
  return `0x${letters.join('')}`;
}

/** A secp256k1 key with its EVM address, lowercase and EIP-55 checksummed. */
export function evmKey(): { secretKey: Uint8Array; lower: string; checksummed: string } {
  const secretKey = secp256k1.utils.randomSecretKey();
  const uncompressed = secp256k1.getPublicKey(secretKey, false);
  const lower = `0x${toHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
  return { secretKey, lower, checksummed: checksummed(lower) };
}

/** `personal_sign` as a wallet does it: EIP-191 over the bytes, `r || s || v` with v = 27/28. */
export function personalSign(secretKey: Uint8Array, messageHex: string): string {
  const recovered = secp256k1.sign(eip191Hash(fromHex(messageHex)), secretKey, {
    prehash: false,
    format: 'recovered',
  });
  const recovery = recovered[0] ?? 0;
  return `0x${toHex(recovered.subarray(1))}${(27 + recovery).toString(16)}`;
}

export function utf8Hex(text: string): string {
  return `0x${toHex(UTF8.encode(text))}`;
}

export interface FakeStandardWallet {
  name: string;
  icon?: string;
  chains: readonly string[];
  features: Record<string, unknown>;
  /** What `signMessage` was asked to sign, decoded. */
  signedTexts: string[];
  /** The accounts `signMessage` was called with. */
  signedFor: string[];
}

interface SolanaWalletOptions {
  name?: string;
  icon?: string;
  chains?: readonly string[];
  /** Account addresses the wallet shares, each with its key when it can sign. */
  accounts?: { address: string; secretKey?: Uint8Array }[];
  withSignMessage?: boolean;
  connect?: () => Promise<unknown>;
  /** Replace the signature the wallet answers with. */
  sign?: (input: { address: string; message: Uint8Array }) => Promise<unknown>;
}

/** A Wallet Standard wallet that signs with real ed25519 keys. */
export function fakeSolanaWallet(options: SolanaWalletOptions = {}): FakeStandardWallet {
  const accounts = options.accounts ?? [solanaKey()];
  const wallet: FakeStandardWallet = {
    name: options.name ?? 'Fake Solana',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    chains: options.chains ?? ['solana:devnet', 'solana:mainnet'],
    features: {},
    signedTexts: [],
    signedFor: [],
  };
  wallet.features['standard:connect'] = {
    connect:
      options.connect ??
      (() =>
        Promise.resolve({
          accounts: accounts.map((account) => ({
            address: account.address,
            chains: wallet.chains,
          })),
        })),
  };
  if (options.withSignMessage !== false) {
    wallet.features['solana:signMessage'] = {
      async signMessage(...inputs: { account: { address: string }; message: Uint8Array }[]) {
        const outputs: unknown[] = [];
        for (const input of inputs) {
          wallet.signedTexts.push(UTF8_DECODER.decode(input.message));
          wallet.signedFor.push(input.account.address);
          if (options.sign !== undefined) {
            outputs.push(
              await options.sign({ address: input.account.address, message: input.message }),
            );
            continue;
          }
          const key = accounts.find((account) => account.address === input.account.address);
          if (key?.secretKey === undefined) {
            throw new Error('unknown account');
          }
          outputs.push({
            signedMessage: input.message,
            signature: ed25519.sign(input.message, key.secretKey),
          });
        }
        return outputs;
      },
    };
  }
  return wallet;
}

/**
 * Inject a Wallet Standard wallet the way the standard does it: dispatch
 * `register-wallet`, and answer every later `app-ready`. Returns a remover.
 */
export function injectStandardWallet(target: Window, wallet: FakeStandardWallet): () => void {
  const callback = (api: { register: (...wallets: unknown[]) => unknown }) => {
    api.register(wallet);
  };
  const onAppReady = (event: Event) => {
    const api = (event as CustomEvent<{ register: (...wallets: unknown[]) => unknown }>).detail;
    callback(api);
  };
  target.addEventListener('wallet-standard:app-ready', onAppReady);
  target.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  return () => target.removeEventListener('wallet-standard:app-ready', onAppReady);
}

export interface RequestCall {
  method: string;
  params?: readonly unknown[];
}

interface EvmProviderOptions {
  /** Accounts the wallet answers `eth_requestAccounts` with, each with its key. */
  accounts?: { address: string; secretKey: Uint8Array }[];
  requestAccounts?: () => Promise<unknown>;
  /** Replace the answer to `personal_sign`. */
  sign?: (params: readonly unknown[]) => Promise<unknown>;
}

export interface FakeProvider {
  request(args: RequestCall): Promise<unknown>;
  calls: RequestCall[];
}

/** An EIP-1193 provider that signs `personal_sign` with real secp256k1 keys. */
export function fakeEvmProvider(options: EvmProviderOptions = {}): FakeProvider {
  const accounts =
    options.accounts ??
    [evmKey()].map((key) => ({ address: key.checksummed, secretKey: key.secretKey }));
  const calls: RequestCall[] = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      if (args.method === 'eth_requestAccounts') {
        return options.requestAccounts === undefined
          ? accounts.map((account) => account.address)
          : options.requestAccounts();
      }
      if (args.method === 'personal_sign') {
        const params = args.params ?? [];
        if (options.sign !== undefined) {
          return options.sign(params);
        }
        const [messageHex, address] = params;
        const key = accounts.find(
          (account) => account.address.toLowerCase() === String(address).toLowerCase(),
        );
        if (key === undefined || typeof messageHex !== 'string') {
          throw new Error('unknown account');
        }
        return personalSign(key.secretKey, messageHex);
      }
      throw new Error(`unexpected ${args.method}`);
    },
  };
}

/** An EIP-6963 announcement now and on every later `requestProvider`. Returns a remover. */
export function announceEvmWallet(
  target: Window,
  info: { uuid: string; name: string; icon?: string; rdns?: string },
  provider: unknown,
): () => void {
  const announce = () => {
    target.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    );
  };
  target.addEventListener('eip6963:requestProvider', announce);
  announce();
  return () => target.removeEventListener('eip6963:requestProvider', announce);
}

/** A user rejection as EIP-1193 wallets throw it. */
export function userRejected(): Error {
  return Object.assign(new Error('User rejected the request.'), { code: 4001 });
}
