/**
 * Payout proofs (A5): the payout wallet signs `elisym-payto:v1:<owner>:<caip19>`,
 * and the page checks the signature itself with the same verifier the server
 * uses before it offers the proof for saving. Nothing is stored here.
 */
import { paytoProofMessage, parseCaip19, verifyPaytoProof } from '@elisym/commerce';
import { getBase58Decoder } from '@solana/kit';
import {
  knownWallet,
  type Eip1193Provider,
  type StandardWallet,
  type WalletChoice,
  type WalletFamily,
} from './discovery';

export type ProofErrorCode =
  | 'unavailable'
  | 'rejected'
  | 'wrong_address'
  | 'bad_signature'
  | 'no_account';

export class ProofError extends Error {
  readonly code: ProofErrorCode;

  constructor(code: ProofErrorCode, message: string) {
    super(message);
    this.name = 'ProofError';
    this.code = code;
  }
}

/** EIP-1193 "user rejected the request". */
const USER_REJECTED = 4001;
const UTF8 = new TextEncoder();

interface StandardAccount {
  address: string;
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly StandardAccount[] }>;
}

interface SignMessageFeature {
  signMessage(
    ...inputs: { account: StandardAccount; message: Uint8Array }[]
  ): Promise<readonly { signedMessage?: Uint8Array; signature: Uint8Array }[]>;
}

/**
 * The family a payout coin (caip19) is signed with: solana namespace ->
 * 'solana', eip155 (EVM and Tempo) -> 'evm'. undefined for anything else.
 */
export function familyOf(caip19: string): WalletFamily | undefined {
  return parseCaip19(caip19)?.chain.family;
}

/** The exact text the wallet signs (commerce's `elisym-payto:v1:<owner hex>:<caip19>`). */
export function proofMessage(ownerPubkey: string, caip19: string): string {
  return paytoProofMessage(ownerPubkey, caip19);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isUserRejection(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === USER_REJECTED
  );
}

async function signWithSolana(
  wallet: StandardWallet,
  message: string,
  expectedAddress: string | undefined,
): Promise<{ address: string; signature: string }> {
  const connect = wallet.features['standard:connect'] as ConnectFeature;
  const signer = wallet.features['solana:signMessage'] as SignMessageFeature;
  let accounts: readonly StandardAccount[];
  try {
    ({ accounts } = await connect.connect());
  } catch {
    throw new ProofError('rejected', 'The wallet did not connect.');
  }
  const usable = Array.isArray(accounts)
    ? accounts.filter((account) => typeof account?.address === 'string')
    : [];
  if (usable.length === 0) {
    throw new ProofError('no_account', 'The wallet shared no account.');
  }
  const account =
    expectedAddress === undefined
      ? usable[0]
      : usable.find((candidate) => candidate.address === expectedAddress);
  if (account === undefined) {
    throw new ProofError('wrong_address', 'The wallet account is not the payout address.');
  }
  let signed: readonly { signature: Uint8Array }[];
  try {
    signed = await signer.signMessage({ account, message: UTF8.encode(message) });
  } catch {
    throw new ProofError('rejected', 'The wallet did not sign.');
  }
  const signature = Array.isArray(signed) ? signed[0]?.signature : undefined;
  if (!(signature instanceof Uint8Array)) {
    throw new ProofError('bad_signature', 'The wallet returned no valid signature.');
  }
  return { address: account.address, signature: getBase58Decoder().decode(signature) };
}

async function signWithEvm(
  provider: Eip1193Provider,
  message: string,
  expectedAddress: string | undefined,
): Promise<{ address: string; signature: string }> {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (error) {
    throw isUserRejection(error)
      ? new ProofError('rejected', 'The wallet did not connect.')
      : new ProofError('unavailable', 'The wallet could not be reached.');
  }
  const usable = Array.isArray(accounts)
    ? accounts.filter((account): account is string => typeof account === 'string')
    : [];
  if (usable.length === 0) {
    throw new ProofError('no_account', 'The wallet shared no account.');
  }
  const account =
    expectedAddress === undefined
      ? usable[0]
      : usable.find((candidate) => candidate.toLowerCase() === expectedAddress.toLowerCase());
  if (account === undefined) {
    throw new ProofError('wrong_address', 'The wallet account is not the payout address.');
  }
  let signature: unknown;
  try {
    signature = await provider.request({
      method: 'personal_sign',
      params: [`0x${toHex(UTF8.encode(message))}`, account],
    });
  } catch (error) {
    throw isUserRejection(error)
      ? new ProofError('rejected', 'The wallet did not sign.')
      : new ProofError('unavailable', 'The wallet could not sign.');
  }
  if (typeof signature !== 'string') {
    throw new ProofError('bad_signature', 'The wallet returned no valid signature.');
  }
  return { address: account.toLowerCase(), signature: signature.toLowerCase() };
}

/**
 * Connect the wallet, sign proofMessage, check it locally with commerce
 * verifyPaytoProof. Returns the address as the payout must hold it (EVM
 * lowercase, Solana base58 exact) and the signature (Solana base58; EVM 0x +
 * 130 hex). If `expectedAddress` is given and the wallet's account differs (EVM
 * case-insensitive, Solana exact) -> ProofError('wrong_address').
 *
 * A Solana wallet that throws is taken as a refusal (Wallet Standard names no
 * error codes); an EVM wallet refuses with 4001, any other error is 'unavailable'.
 */
export async function signPayoutProof(input: {
  wallet: WalletChoice;
  ownerPubkey: string;
  caip19: string;
  expectedAddress?: string;
}): Promise<{ address: string; signature: string }> {
  const coin = parseCaip19(input.caip19);
  const known = knownWallet(input.wallet);
  if (coin === undefined || known === undefined || coin.chain.family !== known.family) {
    throw new ProofError('unavailable', 'This wallet cannot sign for this coin.');
  }
  const message = proofMessage(input.ownerPubkey, input.caip19);
  const proof =
    known.family === 'solana'
      ? await signWithSolana(known.wallet, message, input.expectedAddress)
      : await signWithEvm(known.provider, message, input.expectedAddress);
  const valid = verifyPaytoProof({
    chain: coin.chain,
    address: proof.address,
    ownerPubkey: input.ownerPubkey,
    caip19: input.caip19,
    signature: proof.signature,
  });
  if (!valid) {
    throw new ProofError('bad_signature', 'The wallet signature does not prove this address.');
  }
  return proof;
}

/**
 * EVM-only paste fallback: true when `signature` is a valid EIP-191 proof for
 * (owner, caip19) by `address`. Always false for Solana coins.
 */
export function checkPastedProof(input: {
  ownerPubkey: string;
  caip19: string;
  address: string;
  signature: string;
}): boolean {
  const coin = parseCaip19(input.caip19);
  if (coin === undefined || coin.chain.family !== 'evm') {
    return false;
  }
  return verifyPaytoProof({
    chain: coin.chain,
    address: input.address,
    ownerPubkey: input.ownerPubkey,
    caip19: input.caip19,
    signature: input.signature,
  });
}
