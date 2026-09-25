/**
 * Direct-mode payments on Solana: the payer pays a payee's address without a
 * quote from the payee, under a reference both sides derive from the order
 * (`deriveOrderPaymentReference` in `@elisym/commerce`).
 *
 * `verifyPayment` answers "a transaction carries this reference and the
 * recipient's balance went up enough". That is not enough here: the payee may
 * be one of several stores of one owner, each with its own claim ledger, and a
 * single transfer carrying the references of two orders would satisfy both. So
 * a direct payment is bound at the INSTRUCTION level - the transfer itself names
 * the reference - and only the bound instructions' own amounts count.
 *
 * The same check runs on the RPC's view of a landed transaction (the payee) and
 * on the message a wallet signed (the payer, before broadcasting), so both sides
 * judge one rule.
 */
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from '@solana-program/token';
import {
  type CompiledTransactionMessage,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  address,
  getBase58Encoder,
  isAddress,
  isSignature,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  ELISYM_PROTOCOL_TAG,
  PAYMENT_DEFAULTS,
  SYSTEM_PROGRAM_ADDRESS_STR,
} from '../constants';
import type { Network, PaymentAssetRef, PaymentRequestData } from '../types';
import type { LoadedAddresses } from './account-keys';
import { mergeAccountKeys } from './account-keys';
import type { Asset } from './assets';
import {
  NATIVE_SOL,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  assetsFor,
  resolveAssetFromPaymentRequest,
} from './assets';
import { readBalance, isReadableTokenRow } from './read-balance';
import { parsePaymentRequest } from './schema';

/** SPL Token `TransferChecked`: `[12, amount u64 LE, decimals u8]`. */
const TRANSFER_CHECKED_DISCRIMINATOR = 12;
const TRANSFER_CHECKED_DATA_LENGTH = 10;
/** Its own accounts: source, mint, destination, authority. Our two markers follow. */
const TRANSFER_CHECKED_OWN_ACCOUNTS = 4;
/** System `Transfer`: `[2, 0, 0, 0, lamports u64 LE]`. */
const SYSTEM_TRANSFER_DISCRIMINATOR = 2;
const SYSTEM_TRANSFER_DATA_LENGTH = 12;
/** Its own accounts: source, destination. Our two markers follow. */
const SYSTEM_TRANSFER_OWN_ACCOUNTS = 2;
/** One page of `getSignaturesForAddress`, the RPC's own maximum. */
const SIGNATURE_PAGE_LIMIT = 1000;
const DEFAULT_MAX_SIGNATURE_PAGES = 10;
const EARLIEST_SOLANA_SECONDS = 1_600_000_000;

const LATEST_SOLANA_SECONDS = 7_258_118_400;
const DIRECT_EXPIRY_SECS = PAYMENT_DEFAULTS.PAYMENT_EXPIRY_SECS;

/**
 * Addresses a reference must never be, on the payer's and the payee's side alike:
 * a reference equal to one of them either cannot be told apart from the payment's
 * own accounts or lists that program's whole history, so the payment is never found.
 * The payee's token account is refused too, where it is known (it takes a lookup).
 */
function isDeniedReference(reference: string, recipient: string, asset: Asset): boolean {
  return [
    recipient,
    ELISYM_PROTOCOL_TAG as string,
    asset.mint,
    TOKEN_PROGRAM_ADDRESS as string,
    TOKEN_2022_PROGRAM_ADDRESS_STR,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS as string,
    SYSTEM_PROGRAM_ADDRESS_STR,
    COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
    MEMO_PROGRAM_ADDRESS as string,
  ].includes(reference);
}

// ---- composing ---------------------------------------------------------------

export interface ComposeSolanaPaymentRequestOptions {
  /** The payee's WALLET address (the owner of the token account for an SPL asset). */
  recipient: string;
  /** The total, in the asset's subunits. There is no fee leg in direct mode. */
  amount: bigint;
  /** A Solana asset of `network`, from the registry. */
  asset: Asset;
  network: Network;
  /** The order's derived reference, base58. */
  reference: string;
  /** Epoch SECONDS on the chain's clock. */
  createdAt: number;
  expirySecs?: number;
}

/**
 * The v1 request for a direct payment: the given reference, no fee leg. Parsed
 * by the schema every reader parses it with. Throws on anything the payer must
 * not send, with a fixed message - the payee's address can come from outside.
 */
export function composeSolanaPaymentRequest(
  options: ComposeSolanaPaymentRequestOptions,
): PaymentRequestData {
  if (typeof options.recipient !== 'string' || !isAddress(options.recipient)) {
    throw new Error('The payee is not a Solana address.');
  }
  if (options.asset === null || typeof options.asset !== 'object') {
    throw new Error('The asset is not a Solana coin of that network.');
  }
  if (typeof options.reference !== 'string' || !isAddress(options.reference)) {
    throw new Error('The reference is not a Solana address.');
  }
  if (isDeniedReference(options.reference, options.recipient, options.asset)) {
    throw new Error('The reference cannot be the payee, the protocol tag, the mint or a program.');
  }
  if (
    typeof options.amount !== 'bigint' ||
    options.amount <= 0n ||
    options.amount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('The amount must be a positive whole number of subunits within 2^53.');
  }
  if (
    !Number.isInteger(options.createdAt) ||
    options.createdAt < EARLIEST_SOLANA_SECONDS ||
    options.createdAt > LATEST_SOLANA_SECONDS
  ) {
    throw new Error('createdAt must be a whole number of epoch SECONDS.');
  }
  const coin = assetsFor('solana', options.network).find(
    (candidate) => candidate.token === options.asset.token && candidate.mint === options.asset.mint,
  );
  if (coin === undefined) {
    throw new Error('The asset is not a Solana coin of that network.');
  }
  const assetRef: PaymentAssetRef | undefined =
    coin === NATIVE_SOL || coin.mint === undefined
      ? undefined
      : { chain: coin.chain, token: coin.token, mint: coin.mint, decimals: coin.decimals };
  const request: PaymentRequestData = {
    recipient: options.recipient,
    amount: Number(options.amount),
    reference: options.reference,
    created_at: options.createdAt,
    expiry_secs: options.expirySecs ?? DIRECT_EXPIRY_SECS,
    ...(assetRef ? { asset: assetRef } : {}),
    network: options.network,
  };
  const parsed = parsePaymentRequest(JSON.stringify(request));
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return request;
}

// ---- the instruction-level binding -------------------------------------------

/** One instruction, with each account's role as the TRANSACTION marks it. */
export interface DirectInstruction {
  program: string;
  accounts: readonly { address: string; writable: boolean; signer: boolean }[];
  data: Uint8Array;
}

interface MessageHeader {
  signers: number;
  readonlySigners: number;
  readonlyNonSigners: number;
}

function staticRole(index: number, total: number, header: MessageHeader) {
  const signer = index < header.signers;
  const writable = signer
    ? index < header.signers - header.readonlySigners
    : index < total - header.readonlyNonSigners;
  return { signer, writable };
}

/** A header count: a whole number from 0 up to `limit`. */
function isCount(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= limit;
}

function isIndexList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0);
}

/**
 * The instructions of a message a WALLET returned. A message with address
 * lookup tables is refused: the payer built it without any, and resolving a
 * table offline is not possible.
 */
export function directInstructionsFromCompiledMessage(
  message: CompiledTransactionMessage,
): DirectInstruction[] {
  if (message.version !== 'legacy' && message.version !== 0) {
    throw new Error('A signed message of this version is not one the payer built.');
  }
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) {
    throw new Error('A signed message with address lookup tables is not one the payer built.');
  }
  const keys = message.staticAccounts.map(String);
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } =
    message.header;
  if (
    !isCount(numSignerAccounts, keys.length) ||
    !isCount(numReadonlySignerAccounts, numSignerAccounts) ||
    !isCount(numReadonlyNonSignerAccounts, keys.length - numSignerAccounts)
  ) {
    throw new Error('The signed message has a header that does not fit its keys.');
  }
  const header: MessageHeader = {
    signers: message.header.numSignerAccounts,
    readonlySigners: message.header.numReadonlySignerAccounts,
    readonlyNonSigners: message.header.numReadonlyNonSignerAccounts,
  };
  return message.instructions.map((instruction) => {
    const program = keys[instruction.programAddressIndex];
    const indices = instruction.accountIndices ?? [];
    if (program === undefined || indices.some((index) => keys[index] === undefined)) {
      throw new Error('The signed message names an account it does not hold.');
    }
    return {
      program,
      accounts: indices.map((index) => ({
        address: keys[index] ?? '',
        ...staticRole(index, keys.length, header),
      })),
      data: instruction.data ? new Uint8Array(instruction.data) : new Uint8Array(),
    };
  });
}

function fieldOf(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The top-level instructions of a transaction as `getTransaction` answers it
 * with `encoding: 'json'` - raw indices, never `jsonParsed` (its parsers drop or
 * relabel the extra accounts this check reads). Lookup-table addresses follow
 * the static keys, writable first, as the balance arrays index them.
 */
export function directInstructionsFromRpcTransaction(transaction: unknown): DirectInstruction[] {
  const message = fieldOf(fieldOf(transaction, 'transaction'), 'message');
  const staticKeys = fieldOf(message, 'accountKeys');
  const header = fieldOf(message, 'header');
  const instructions = fieldOf(message, 'instructions');
  const loaded = fieldOf(fieldOf(transaction, 'meta'), 'loadedAddresses');
  const loadedWritable = fieldOf(loaded, 'writable') ?? [];
  const loadedReadonly = fieldOf(loaded, 'readonly') ?? [];
  const signers = fieldOf(header, 'numRequiredSignatures');
  const readonlySigners = fieldOf(header, 'numReadonlySignedAccounts');
  const readonlyNonSigners = fieldOf(header, 'numReadonlyUnsignedAccounts');
  if (
    !Array.isArray(staticKeys) ||
    !staticKeys.every((key) => typeof key === 'string') ||
    !Array.isArray(loadedWritable) ||
    !Array.isArray(loadedReadonly) ||
    ![...loadedWritable, ...loadedReadonly].every((key) => typeof key === 'string') ||
    !Array.isArray(instructions) ||
    !isCount(signers, staticKeys.length) ||
    !isCount(readonlySigners, typeof signers === 'number' ? signers : 0) ||
    !isCount(readonlyNonSigners, staticKeys.length - (typeof signers === 'number' ? signers : 0))
  ) {
    throw new Error('The transaction does not have the shape of a json-encoded one.');
  }
  const staticHeader: MessageHeader = { signers, readonlySigners, readonlyNonSigners };
  const keys: string[] = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const roleOf = (index: number) => {
    if (index < staticKeys.length) {
      return staticRole(index, staticKeys.length, staticHeader);
    }
    return { signer: false, writable: index < staticKeys.length + loadedWritable.length };
  };
  const base58 = getBase58Encoder();
  return instructions.map((instruction) => {
    const programIndex = fieldOf(instruction, 'programIdIndex');
    const indices = fieldOf(instruction, 'accounts');
    const data = fieldOf(instruction, 'data');
    if (
      typeof programIndex !== 'number' ||
      keys[programIndex] === undefined ||
      !isIndexList(indices) ||
      indices.some((index) => keys[index] === undefined) ||
      typeof data !== 'string'
    ) {
      throw new Error('The transaction names an instruction it cannot read.');
    }
    return {
      program: keys[programIndex] ?? '',
      accounts: indices.map((index) => ({ address: keys[index] ?? '', ...roleOf(index) })),
      data: new Uint8Array(base58.encode(data)),
    };
  });
}

export interface BoundTransferExpectation {
  /** The order's reference, base58. */
  reference: string;
  /** The payee's WALLET address. */
  recipient: string;
  asset: Asset;
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function isMarker(
  account: { address: string; writable: boolean; signer: boolean } | undefined,
  expected: string,
): boolean {
  return (
    account !== undefined && account.address === expected && !account.writable && !account.signer
  );
}

interface PayeeTarget {
  program: string;
  /** The account that is credited: the payee itself for SOL, its associated token account otherwise. */
  destination: string;
  asset: Asset;
}

async function payeeTarget(recipient: string, asset: Asset): Promise<PayeeTarget> {
  if (asset.mint === undefined) {
    return { program: SYSTEM_PROGRAM_ADDRESS_STR, destination: recipient, asset };
  }
  const program = asset.tokenProgram ?? (TOKEN_PROGRAM_ADDRESS as string);
  const [ata] = await findAssociatedTokenPda({
    owner: address(recipient),
    mint: address(asset.mint),
    tokenProgram: address(program),
  });
  return { program, destination: ata, asset };
}

interface ReadTransfer {
  source: string;
  destination: string;
  amount: bigint;
  /** The accounts after the transfer's own (the markers, or a multisig's signers). */
  extra: DirectInstruction['accounts'];
}

/** A transfer of the target's asset, as the program reads it, or `undefined`. */
function readTransfer(
  instruction: DirectInstruction,
  target: PayeeTarget,
): ReadTransfer | undefined {
  if (instruction.program !== target.program) {
    return undefined;
  }
  const { accounts, data } = instruction;
  if (target.asset.mint === undefined) {
    if (
      data.length !== SYSTEM_TRANSFER_DATA_LENGTH ||
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !==
        SYSTEM_TRANSFER_DISCRIMINATOR ||
      accounts.length < SYSTEM_TRANSFER_OWN_ACCOUNTS
    ) {
      return undefined;
    }
    return {
      source: accounts[0]?.address ?? '',
      destination: accounts[1]?.address ?? '',
      amount: readU64(data, 4),
      extra: accounts.slice(SYSTEM_TRANSFER_OWN_ACCOUNTS),
    };
  }
  if (
    data.length !== TRANSFER_CHECKED_DATA_LENGTH ||
    data[0] !== TRANSFER_CHECKED_DISCRIMINATOR ||
    data[9] !== target.asset.decimals ||
    accounts.length < TRANSFER_CHECKED_OWN_ACCOUNTS ||
    accounts[1]?.address !== target.asset.mint
  ) {
    return undefined;
  }
  return {
    source: accounts[0]?.address ?? '',
    destination: accounts[2]?.address ?? '',
    amount: readU64(data, 1),
    extra: accounts.slice(TRANSFER_CHECKED_OWN_ACCOUNTS),
  };
}

/**
 * The amount the given instructions pay to the payee UNDER this reference.
 *
 * A bound instruction is a top-level transfer of the asset's program - SPL
 * `TransferChecked` with the asset's mint and decimals into the payee's
 * associated token account, or a System `Transfer` of lamports to the payee -
 * FROM another account, whose accounts are the transfer's own followed by
 * exactly two read-only, non-signer accounts: this reference, then
 * `ELISYM_PROTOCOL_TAG`. That is how `buildPaymentInstructions` attaches them.
 * Only bound instructions count, and their amounts are summed; a transfer that
 * names another reference, or a second reference in the tag's place, pays this
 * order nothing. A self-transfer (source = destination) moves nothing - SPL
 * Token even lets a delegate repeat it without spending its allowance - so it
 * never counts.
 */
export async function boundTransferAmount(
  instructions: readonly DirectInstruction[],
  expectation: BoundTransferExpectation,
): Promise<bigint> {
  const { reference, recipient, asset } = expectation;
  const tag = ELISYM_PROTOCOL_TAG as string;
  if (asset === null || typeof asset !== 'object' || asset.chain !== 'solana') {
    return 0n;
  }
  if (
    typeof reference !== 'string' ||
    typeof recipient !== 'string' ||
    !isAddress(reference) ||
    !isAddress(recipient) ||
    isDeniedReference(reference, recipient, asset)
  ) {
    return 0n;
  }
  const target = await payeeTarget(recipient, asset);
  if (reference === target.destination) {
    return 0n;
  }
  let total = 0n;
  for (const instruction of instructions) {
    const transfer = readTransfer(instruction, target);
    if (
      transfer !== undefined &&
      transfer.destination === target.destination &&
      transfer.source !== target.destination &&
      transfer.extra.length === 2 &&
      isMarker(transfer.extra[0], reference) &&
      isMarker(transfer.extra[1], tag)
    ) {
      total += transfer.amount;
    }
  }
  return total;
}

/**
 * Everything the instructions transfer into the payee from other accounts, in
 * the forms that can be bound (above), under any markers or none. The payee's
 * balance must rise at least this much: a transaction whose bound credits add
 * up to more than what actually arrived is claiming the same money twice.
 */
async function transferredIntoPayee(
  instructions: readonly DirectInstruction[],
  recipient: string,
  asset: Asset,
): Promise<bigint> {
  const target = await payeeTarget(recipient, asset);
  let total = 0n;
  for (const instruction of instructions) {
    const transfer = readTransfer(instruction, target);
    if (
      transfer !== undefined &&
      transfer.destination === target.destination &&
      transfer.source !== target.destination
    ) {
      total += transfer.amount;
    }
  }
  return total;
}

// ---- finding and verifying ---------------------------------------------------

export interface ReferenceSignature {
  signature: string;
  failed: boolean;
  blockTime: number | null;
  slot: bigint;
}

export interface ListReferenceSignaturesOptions {
  /** Stop once a signature is older than this (epoch seconds); a null block time does not stop. */
  notBefore: number;
  commitment?: 'confirmed' | 'finalized';
  maxPages?: number;
}

/**
 * Every signature that touched `reference`, newest first, paged with `before`
 * until one is older than `notBefore`. A public reference can be spammed past
 * one page, so a single page is never a complete answer. `complete` is false
 * when the page cap stopped the walk first. A node error throws rather than
 * returning a partial list.
 */
export async function listReferenceSignatures(
  rpc: Rpc<SolanaRpcApi>,
  reference: string,
  options: ListReferenceSignaturesOptions,
): Promise<{ signatures: ReferenceSignature[]; complete: boolean }> {
  if (typeof reference !== 'string' || !isAddress(reference)) {
    throw new Error('The reference is not a Solana address.');
  }
  const maxPages = options.maxPages ?? DEFAULT_MAX_SIGNATURE_PAGES;
  if (
    !Number.isFinite(options.notBefore) ||
    options.notBefore < EARLIEST_SOLANA_SECONDS ||
    options.notBefore > LATEST_SOLANA_SECONDS ||
    !Number.isInteger(maxPages) ||
    maxPages <= 0
  ) {
    throw new Error('notBefore must be epoch seconds and maxPages a positive integer.');
  }
  const signatures: ReferenceSignature[] = [];
  let before: Signature | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await rpc
      .getSignaturesForAddress(address(reference), {
        limit: SIGNATURE_PAGE_LIMIT,
        commitment: options.commitment ?? 'confirmed',
        ...(before ? { before } : {}),
      })
      .send();
    let reachedFloor = false;
    for (const row of rows) {
      const blockTime = row.blockTime === null ? null : Number(row.blockTime);
      signatures.push({
        signature: row.signature,
        failed: row.err !== null,
        blockTime,
        slot: BigInt(row.slot),
      });
      if (blockTime !== null && blockTime < options.notBefore) {
        reachedFloor = true;
      }
    }
    const last = rows[rows.length - 1];
    if (reachedFloor || rows.length < SIGNATURE_PAGE_LIMIT || last === undefined) {
      return { signatures, complete: true };
    }
    before = last.signature;
  }
  return { signatures, complete: false };
}

export type DirectVerification =
  | { verified: true; signature: string; amount: bigint; blockTime: number | null; slot: bigint }
  | {
      verified: false;
      reason:
        | 'bad_request'
        | 'bad_signature'
        | 'not_found'
        | 'rpc_error'
        | 'failed'
        | 'unreadable'
        | 'not_bound'
        | 'underpaid'
        | 'balance_mismatch';
    };

function recipientBalanceChange(
  transaction: unknown,
  recipient: string,
  asset: Asset,
): bigint | null {
  const meta = fieldOf(transaction, 'meta');
  if (asset.mint !== undefined) {
    const sum = (rows: unknown): bigint | null => {
      if (!Array.isArray(rows)) {
        return null;
      }
      let total = 0n;
      for (const row of rows) {
        // An unreadable row is a page this check cannot judge, never a zero baseline.
        if (!isReadableTokenRow(row)) {
          return null;
        }
        if (row.owner !== recipient || row.mint !== asset.mint) {
          continue;
        }
        const amount = readBalance(fieldOf(fieldOf(row, 'uiTokenAmount'), 'amount'));
        if (amount === null) {
          return null;
        }
        total += amount;
      }
      return total;
    };
    const preRows = fieldOf(meta, 'preTokenBalances');
    const postRows = fieldOf(meta, 'postTokenBalances');
    // A token transfer that landed always leaves rows; two empty lists mean the
    // node does not record them, which is not a zero.
    if (
      Array.isArray(preRows) &&
      Array.isArray(postRows) &&
      preRows.length + postRows.length === 0
    ) {
      return null;
    }
    // This runs only once a transfer into the payee's token account landed, so
    // that account has a post row; a page without one is incomplete, not a zero.
    if (
      Array.isArray(postRows) &&
      !postRows.some(
        (row) => isReadableTokenRow(row) && row.owner === recipient && row.mint === asset.mint,
      )
    ) {
      return null;
    }
    const pre = sum(preRows);
    const post = sum(postRows);
    return pre === null || post === null ? null : post - pre;
  }
  const message = fieldOf(fieldOf(transaction, 'transaction'), 'message');
  const staticKeys = fieldOf(message, 'accountKeys');
  if (!Array.isArray(staticKeys)) {
    return null;
  }
  // The balance arrays index the static keys, then the loaded writable, then the
  // loaded read-only addresses - the order the instruction reader uses too.
  const keys = mergeAccountKeys(
    staticKeys as readonly string[],
    fieldOf(meta, 'loadedAddresses') as LoadedAddresses | undefined,
  );
  const index = keys.indexOf(recipient);
  const preBalances = fieldOf(meta, 'preBalances');
  const postBalances = fieldOf(meta, 'postBalances');
  if (!Array.isArray(preBalances) || !Array.isArray(postBalances)) {
    return null;
  }
  const pre = readBalance(preBalances[index]);
  const post = readBalance(postBalances[index]);
  return index < 0 || pre === null || post === null ? null : post - pre;
}

/**
 * Whether the transaction `signature` pays `request` in direct mode: it landed
 * without error, its bound instructions (above) sum to at least the amount, and
 * the payee's balance rose at least as much. A payee still claims each
 * signature once - this answers only what one transaction is worth to one order.
 *
 * `rpc_error`, `unreadable` and `not_found` are questions to ask again (a node
 * failed, a page could not be read, the transaction has not landed yet);
 * `bad_request` is the caller's; `bad_signature`, `failed`, `not_bound`,
 * `underpaid` and `balance_mismatch` are final for that signature.
 */
export async function verifyDirectSolanaPayment(
  rpc: Rpc<SolanaRpcApi>,
  request: PaymentRequestData,
  signature: string,
  options: { commitment?: 'confirmed' | 'finalized' } = {},
): Promise<DirectVerification> {
  // The request is re-read by the schema: a fractional or non-positive amount
  // would make any bound transfer verify, and the signature comes from a receipt.
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    return { verified: false, reason: 'bad_request' };
  }
  const parsed = parsePaymentRequest(serialized);
  if (!parsed.ok) {
    return { verified: false, reason: 'bad_request' };
  }
  // Every value below is read from what the schema accepted, not the caller's object.
  const checked = parsed.data;
  if (typeof signature !== 'string' || !isSignature(signature)) {
    // It can never land, so asking again would be pointless.
    return { verified: false, reason: 'bad_signature' };
  }
  // Direct mode has no fee leg; a request that names one is not a direct request.
  if (checked.fee_address !== undefined || (checked.fee_amount ?? 0) !== 0) {
    return { verified: false, reason: 'bad_request' };
  }
  let asset: Asset;
  try {
    asset = resolveAssetFromPaymentRequest(checked);
  } catch {
    return { verified: false, reason: 'bad_request' };
  }
  // A coin of the request's own network: the mint is what the check compares.
  const network = checked.network ?? 'devnet';
  if (
    !assetsFor('solana', network).some(
      (coin) => coin.token === asset.token && coin.mint === asset.mint,
    )
  ) {
    return { verified: false, reason: 'bad_request' };
  }
  // A reference no transfer can be bound to is the caller's error, not a verdict on
  // any signature: refuse it here rather than answer `not_bound` for every payment.
  if (!isAddress(checked.recipient) || !isAddress(checked.reference)) {
    return { verified: false, reason: 'bad_request' };
  }
  const target = await payeeTarget(checked.recipient, asset);
  if (
    isDeniedReference(checked.reference, checked.recipient, asset) ||
    checked.reference === target.destination
  ) {
    return { verified: false, reason: 'bad_request' };
  }
  let transaction: unknown;
  try {
    transaction = await rpc
      .getTransaction(signature, {
        commitment: options.commitment ?? 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
  } catch {
    // A node that fails (or a transaction version it will not serve) says
    // nothing about the payment: the caller asks again.
    return { verified: false, reason: 'rpc_error' };
  }
  if (transaction === null || transaction === undefined) {
    return { verified: false, reason: 'not_found' };
  }
  const meta = fieldOf(transaction, 'meta');
  if (meta === null || meta === undefined) {
    return { verified: false, reason: 'unreadable' };
  }
  const failure = fieldOf(meta, 'err');
  if (failure === undefined) {
    return { verified: false, reason: 'unreadable' };
  }
  if (failure !== null) {
    return { verified: false, reason: 'failed' };
  }
  let instructions: DirectInstruction[];
  try {
    instructions = directInstructionsFromRpcTransaction(transaction);
  } catch {
    return { verified: false, reason: 'unreadable' };
  }
  const bound = await boundTransferAmount(instructions, {
    reference: checked.reference,
    recipient: checked.recipient,
    asset,
  });
  if (bound === 0n) {
    return { verified: false, reason: 'not_bound' };
  }
  const expected = BigInt(checked.amount);
  if (bound < expected) {
    return { verified: false, reason: 'underpaid' };
  }
  const change = recipientBalanceChange(transaction, checked.recipient, asset);
  const arrived = await transferredIntoPayee(instructions, checked.recipient, asset);
  if (change === null) {
    // A page this check cannot read is a question to ask again, not a verdict.
    return { verified: false, reason: 'unreadable' };
  }
  if (change < expected || change < arrived) {
    return { verified: false, reason: 'balance_mismatch' };
  }
  const blockTime = fieldOf(transaction, 'blockTime');
  const slot = fieldOf(transaction, 'slot');
  if (typeof slot !== 'number' && typeof slot !== 'bigint') {
    return { verified: false, reason: 'unreadable' };
  }
  return {
    verified: true,
    signature,
    amount: bound,
    blockTime:
      typeof blockTime === 'number' || typeof blockTime === 'bigint' ? Number(blockTime) : null,
    slot: BigInt(slot),
  };
}
