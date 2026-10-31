/**
 * The payout wallet's proof (plan section 3): one message signed through the
 * wallet extension's injected provider - Solana `signMessage`, EVM
 * `personal_sign` - with no wallet adapter library on the key-holding page.
 * Whatever the wallet answers is checked with `verifyPaytoProof` before it is
 * used: a wallet that signs for another address, or not at all, proves nothing.
 */
import { parseCaip19, paytoProofMessage, verifyPaytoProof } from '@elisym/commerce';
import { base58 } from '@scure/base';
import { payoutAddress } from './payouts';

/** What the console needs of an injected Solana provider (Phantom, Solflare, Backpack...). */
export interface SolanaProvider {
  connect(): Promise<unknown>;
  signMessage(message: Uint8Array, display?: string): Promise<unknown>;
}

/** What the console needs of an injected EIP-1193 provider. */
export interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** The providers the page has (none, either or both). */
export interface WalletProviders {
  solana: SolanaProvider | undefined;
  evm: EvmProvider | undefined;
}

/** Why no proof came back, in the merchant's words. */
export class WalletRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletRefused';
  }
}

/**
 * A property of an injected object, read as the object holds it: on its
 * prototype too (providers are often class instances), enumerable or not,
 * and never a throw (a getter may throw, as blocked site storage does).
 */
function propertyOf(value: unknown, name: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

function isSolanaProvider(value: unknown): value is SolanaProvider {
  return (
    typeof propertyOf(value, 'connect') === 'function' &&
    typeof propertyOf(value, 'signMessage') === 'function'
  );
}

function isEvmProvider(value: unknown): value is EvmProvider {
  return typeof propertyOf(value, 'request') === 'function';
}

/** The providers a window holds: `window.phantom.solana` or `window.solana`, and `window.ethereum`. */
export function injectedProviders(view: unknown): WalletProviders {
  const phantom = propertyOf(propertyOf(view, 'phantom'), 'solana');
  const solana = isSolanaProvider(phantom) ? phantom : propertyOf(view, 'solana');
  const evm = propertyOf(view, 'ethereum');
  return {
    solana: isSolanaProvider(solana) ? solana : undefined,
    evm: isEvmProvider(evm) ? evm : undefined,
  };
}

const UTF8 = new TextEncoder();
/** EIP-1193: the user rejected the request. */
const USER_REJECTED = 4001;

/** The wallet's signature bytes from a `signMessage` answer (`{signature}` or the bytes themselves). */
function signatureBytes(answer: unknown): Uint8Array | undefined {
  const signature = answer instanceof Uint8Array ? answer : propertyOf(answer, 'signature');
  return signature instanceof Uint8Array ? signature : undefined;
}

/** A wallet call whose failure (a rejection, a locked account, anything) is a refusal in the merchant's words. */
async function walletCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new WalletRefused(
      propertyOf(error, 'code') === USER_REJECTED
        ? 'You declined in the wallet: nothing was signed.'
        : 'The wallet did not sign: unlock it, connect the account that holds this address, and try again.',
    );
  }
}

/**
 * The payout wallet's proof that `address` agreed to be paid in `caip19` for
 * this owner, signed through the injected provider of that asset's family and
 * verified before it is returned, with the address as the list carries it.
 */
export async function proveWithWallet(
  providers: WalletProviders,
  input: { ownerPubkey: string; caip19: string; address: string },
): Promise<{ address: string; signature: string }> {
  const parsed = parseCaip19(input.caip19);
  if (parsed === undefined) {
    throw new WalletRefused('That asset is not one a payout takes.');
  }
  const address = payoutAddress(input.caip19, input.address);
  if (address === undefined) {
    throw new WalletRefused('That is not an address on this chain.');
  }
  const message = paytoProofMessage(input.ownerPubkey, input.caip19);
  let signature: string | undefined;
  if (parsed.chain.family === 'solana') {
    const provider = providers.solana;
    if (provider === undefined) {
      throw new WalletRefused('No Solana wallet extension found in this browser.');
    }
    await walletCall(() => provider.connect());
    const answer = await walletCall(() => provider.signMessage(UTF8.encode(message), 'utf8'));
    const bytes = signatureBytes(answer);
    signature = bytes === undefined ? undefined : base58.encode(bytes);
  } else {
    const provider = providers.evm;
    if (provider === undefined) {
      throw new WalletRefused('No Ethereum wallet extension found in this browser.');
    }
    await walletCall(() => provider.request({ method: 'eth_requestAccounts' }));
    const hexMessage = `0x${Array.from(UTF8.encode(message), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const answer = await walletCall(() =>
      provider.request({ method: 'personal_sign', params: [hexMessage, address] }),
    );
    signature = typeof answer === 'string' ? answer : undefined;
  }
  if (
    signature === undefined ||
    !verifyPaytoProof({
      chain: parsed.chain,
      address,
      ownerPubkey: input.ownerPubkey,
      caip19: input.caip19,
      signature,
    })
  ) {
    throw new WalletRefused(
      'The wallet did not sign for this address: connect the wallet that holds it and try again.',
    );
  }
  return { address, signature };
}
