/**
 * Circle USDC over EIP-3009 `transferWithAuthorization` - the `eip3009` rail of
 * Ethereum, Arbitrum and Base. Pure builders and readers: no wallet, no state.
 *
 * The payment binds to an order through the authorization's `nonce`: USDC lets
 * each `(authorizer, nonce)` pair be used once, ever, and emits
 * `AuthorizationUsed(authorizer, nonce)` IMMEDIATELY before the `Transfer` it
 * authorizes (FiatToken makes no external call between the two emits). So a leg
 * counts only as that pair of logs, adjacent, from the USDC proxy - never as the
 * event and some `Transfer` elsewhere in the receipt, which would let one
 * transaction credit a payment that went to someone else.
 *
 * Every reader answers "unreadable" (or `null`) for anything that is not exactly
 * the expected shape. An unreadable value is never a zero, a `false` or an empty
 * list: for money it means "refuse" or "ask again".
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Asset } from '../payment/assets';
import { assetKey, assetsFor } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import {
  CHAINS,
  chainByCaip2,
  isEvmAddressFormat,
  normalizeEvmAddress,
  ZERO_ADDRESS,
} from '../payment/chains';
import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { checkEvmChain } from './config';
import { MAX_LOG_SCAN_REQUESTS, TRANSFER_TOPIC } from './constants';
import { isOnThisChain, isTooMuchError } from './logs';
import {
  readAddressWord,
  readBlockNumber,
  readField,
  readHexData,
  readQuantity,
  readTopicAddress,
  readTopicWord,
  readTxHash,
  readUint256,
  readWords,
  toQuantity,
} from './rpc-read';

/** `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)` - the v2.2 overload that also takes an ERC-1271 signature. */
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = '0xcf092995';
/** `authorizationState(address,bytes32)` -> bool: used OR canceled. */
const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';
const IS_BLACKLISTED_SELECTOR = '0xfe575a87';
const PAUSED_SELECTOR = '0x5c975abb';
const BALANCE_OF_SELECTOR = '0x70a08231';
const DOMAIN_SEPARATOR_SELECTOR = '0x3644e515';
/** OP-stack `GasPriceOracle.getL1Fee(bytes)`. */
const GET_L1_FEE_SELECTOR = '0x49948e0e';

/** `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`. */
export const AUTHORIZATION_USED_TOPIC =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
/** `AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)`. */
export const AUTHORIZATION_CANCELED_TOPIC =
  '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81';

/** keccak256 of the EIP-712 `TransferWithAuthorization` struct type. */
const TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
  '7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267';
/** keccak256 of `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`. */
const EIP712_DOMAIN_TYPEHASH = '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';
/** The zeppelinos implementation slot of `FiatTokenProxy`. */
export const FIAT_TOKEN_IMPLEMENTATION_SLOT =
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
/** An EIP-7702 delegation designator: these three bytes, then the delegate's 20. */
const DELEGATION_DESIGNATOR_PREFIX = '0xef0100';
/** ERC-6492 wraps an undeployed smart wallet's signature and ends with this word. FiatToken does not unwrap it. */
const ERC6492_MAGIC = '6492'.repeat(16);

const SIGNATURE_BYTES = 65;
const WORD_HEX_CHARS = 64;
const MAX_UINT256 = (1n << 256n) - 1n;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const NONCE_RE = /^0x[0-9a-f]{64}$/;
/** The order of the secp256k1 group: a valid `s` is below it, a low one at most half of it. */
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * JSON-RPC error codes an `eth_estimateGas` answers when the CALL fails (geth's
 * revert `3`, the generic `-32000`, Nethermind's `-32015`), as opposed to the
 * request: no meaning is read from the text, and a transport error mistaken for
 * one of these only costs a re-read and a retry (step 5.1).
 */
const EXECUTION_ERROR_CODES: readonly number[] = [3, -32000, -32015];

export type BlockTag = 'latest' | 'safe' | 'finalized';

/** A block as a tag resolved it. */
export interface Eip3009BlockRef {
  number: number;
  hash: string;
  timestamp: number;
}

/** A block named by hash: EIP-1898 `{ blockHash, requireCanonical: true }`. */
export interface PinnedBlock {
  blockHash: string;
}

/** What one authorization says, in the form `eth_signTypedData_v4` takes. */
export interface TransferAuthorizationMessage {
  from: string;
  to: string;
  /** Subunits, decimal. */
  value: string;
  validAfter: '0';
  /** Epoch seconds, decimal. */
  validBefore: string;
  nonce: string;
}

export interface TransferAuthorizationTypedData {
  types: {
    EIP712Domain: readonly { name: string; type: string }[];
    TransferWithAuthorization: readonly { name: string; type: string }[];
  };
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  primaryType: 'TransferWithAuthorization';
  message: TransferAuthorizationMessage;
}

export interface BuildTransferAuthorizationOptions {
  chain: ChainConfig;
  asset: Asset;
  from: string;
  to: string;
  value: bigint;
  /** The 32-byte nonce: the order's reference. */
  nonce: string;
  /** Epoch seconds. */
  validBefore: bigint;
}

const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

const TRANSFER_WITH_AUTHORIZATION_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

interface Eip3009Coin {
  chain: ChainConfig;
  mint: string;
  eip712: { name: string; version: string };
  implementation: string | undefined;
}

/**
 * The registry's own entry for a caller's `chain`, by its CAIP-2 id, when that
 * entry settles over `eip3009`. Every chain fact a reader uses (chain id, credit
 * tag, log range, delegates, L1 fee oracle) comes from it, never from the
 * caller's object.
 */
function registryEip3009Chain(chain: ChainConfig): ChainConfig | undefined {
  const known = chainByCaip2(chain.caip2);
  return known?.family === 'evm' && known.settlement === 'eip3009' ? known : undefined;
}

/**
 * The registry chain and coin an `eip3009` asset belongs to, or `undefined`. By
 * KEY, never by identity: each bundled entry point holds its own copy of the
 * registry, and every fact returned is the registry's, not the caller's.
 */
function eip3009CoinOf(asset: Asset, chain?: ChainConfig): Eip3009Coin | undefined {
  let candidates: readonly ChainConfig[] = Object.values(CHAINS);
  if (chain !== undefined) {
    const known = registryEip3009Chain(chain);
    candidates = known === undefined ? [] : [known];
  }
  for (const candidate of candidates) {
    if (candidate.family !== 'evm' || candidate.settlement !== 'eip3009') {
      continue;
    }
    const coin = assetsFor(candidate.slug, candidate.network).find(
      (known) => assetKey(known) === assetKey(asset),
    );
    if (coin?.mint !== undefined && coin.eip712 !== undefined) {
      return {
        chain: candidate,
        mint: coin.mint.toLowerCase(),
        eip712: coin.eip712,
        implementation: coin.implementation,
      };
    }
  }
  return undefined;
}

function requireEip3009Chain(chain: ChainConfig): ChainConfig {
  const known = registryEip3009Chain(chain);
  if (known === undefined) {
    throw new Error('The chain does not settle over EIP-3009.');
  }
  return known;
}

function requireCoin(asset: Asset, chain?: ChainConfig): Eip3009Coin {
  const coin = eip3009CoinOf(asset, chain);
  if (coin === undefined) {
    throw new Error('The asset is not an EIP-3009 coin of an eip3009 chain from the registry.');
  }
  return coin;
}

function requireAddress(value: string, what: string): string {
  const address = normalizeEvmAddress(value);
  if (address === undefined) {
    throw new Error(`${what} is not an EVM address.`);
  }
  return address;
}

function requireHash(value: string, what: string): string {
  const hash = readTxHash(value);
  if (hash === null) {
    throw new Error(`Not a ${what} hash.`);
  }
  return hash;
}

function requireNonce(nonce: string): string {
  const lower = typeof nonce === 'string' ? nonce.toLowerCase() : '';
  if (!NONCE_RE.test(lower)) {
    throw new Error('The nonce must be 32 bytes of hex.');
  }
  return lower;
}

/** A decimal uint256 field of a message, as the contract reads it; anything else would encode a word that is not one. */
function requireUint256(text: string, name: string): bigint {
  if (typeof text !== 'string' || !DECIMAL_RE.test(text)) {
    throw new Error(`${name} must be a decimal whole number.`);
  }
  const value = BigInt(text);
  if (value > MAX_UINT256) {
    throw new Error(`${name} does not fit in 256 bits.`);
  }
  return value;
}

function wordOf(value: bigint): string {
  return value.toString(16).padStart(WORD_HEX_CHARS, '0');
}

function addressWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(WORD_HEX_CHARS, '0');
}

function addressTopic(address: string): string {
  return `0x${addressWord(address)}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The EIP-712 typed data of one authorization (`validAfter` = 0). Throws for a
 * chain whose settlement is not `eip3009`, an asset without `eip712` (or not that
 * chain's coin), a zero `to`, `to` = the USDC contract, and a value or validBefore
 * that is not a positive uint256 (one wider than 256 bits the encoder would refuse
 * only after the wallet signed).
 */
export function buildTransferAuthorization(
  options: BuildTransferAuthorizationOptions,
): TransferAuthorizationTypedData {
  const chain = requireEip3009Chain(options.chain);
  if (chain.evmChainId === undefined) {
    throw new Error('The chain does not settle over EIP-3009.');
  }
  if (options.asset.eip712 === undefined) {
    throw new Error('The asset has no EIP-712 domain.');
  }
  const coin = requireCoin(options.asset, chain);
  const from = requireAddress(options.from, 'from');
  const to = requireAddress(options.to, 'to');
  if (to === ZERO_ADDRESS) {
    throw new Error('An authorization to the zero address burns the money.');
  }
  if (to === coin.mint) {
    throw new Error('An authorization to the USDC contract itself reaches no one.');
  }
  if (typeof options.value !== 'bigint' || options.value <= 0n) {
    throw new Error('An authorization needs a positive value.');
  }
  if (typeof options.validBefore !== 'bigint' || options.validBefore <= 0n) {
    throw new Error('validBefore must be a positive number of epoch seconds.');
  }
  if (options.value > MAX_UINT256) {
    throw new Error('value does not fit in 256 bits.');
  }
  if (options.validBefore > MAX_UINT256) {
    throw new Error('validBefore does not fit in 256 bits.');
  }
  return {
    types: {
      EIP712Domain: EIP712_DOMAIN_FIELDS,
      TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_FIELDS,
    },
    domain: {
      name: coin.eip712.name,
      version: coin.eip712.version,
      chainId: chain.evmChainId,
      verifyingContract: coin.mint,
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value: options.value.toString(),
      validAfter: '0',
      validBefore: options.validBefore.toString(),
      nonce: requireNonce(options.nonce),
    },
  };
}

function keccakHex(hexBody: string): string {
  return bytesToHex(keccak_256(hexToBytes(hexBody)));
}

function keccakText(text: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(text)));
}

function domainSeparatorOf(domain: TransferAuthorizationTypedData['domain']): string {
  return keccakHex(
    EIP712_DOMAIN_TYPEHASH +
      keccakText(domain.name) +
      keccakText(domain.version) +
      wordOf(BigInt(domain.chainId)) +
      addressWord(domain.verifyingContract),
  );
}

/** The 32-byte digest a wallet signs for this typed data. */
export function hashTransferAuthorization(typedData: TransferAuthorizationTypedData): string {
  const { message } = typedData;
  const structHash = keccakHex(
    TRANSFER_WITH_AUTHORIZATION_TYPEHASH +
      addressWord(message.from) +
      addressWord(message.to) +
      wordOf(BigInt(message.value)) +
      wordOf(BigInt(message.validAfter)) +
      wordOf(BigInt(message.validBefore)) +
      message.nonce.slice(2),
  );
  return `0x${keccakHex(`1901${domainSeparatorOf(typedData.domain)}${structHash}`)}`;
}

/**
 * The `DOMAIN_SEPARATOR()` the registry's EIP-712 domain for `asset` on `chain`
 * produces. The widget compares it with the contract's own before asking for a
 * signature: a proxy upgrade that changed the domain must not collect one.
 */
export function expectedDomainSeparator(chain: ChainConfig, asset: Asset): string {
  const coin = requireCoin(asset, chain);
  const { evmChainId } = coin.chain;
  if (evmChainId === undefined) {
    throw new Error('The chain has no EVM chain id.');
  }
  return `0x${domainSeparatorOf({
    name: coin.eip712.name,
    version: coin.eip712.version,
    chainId: evmChainId,
    verifyingContract: coin.mint,
  })}`;
}

function addressOfPublicKey(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

/**
 * A wallet's typed-data signature in the one form FiatToken's `ECRecover`
 * accepts - 65 bytes, `v` in {27, 28}, low `s` - or `undefined` when it does not
 * recover to `payer` or `payer` is not the authorization's `from`. A high `s` is folded to its low twin (which flips `v`),
 * so a wallet that answers either is served; a signature the contract would
 * revert on is never stored. The same holds for a 7702 payer whose delegate is
 * in `knownDelegates`: that delegate checks the account's own key (PR 0, P2).
 */
export function normalizeAuthorizationSignature(
  typedData: TransferAuthorizationTypedData,
  signature: string,
  payer: string,
): string | undefined {
  const data = readHexData(signature);
  const payerAddress = normalizeEvmAddress(payer);
  if (data === null || data.length !== 2 + SIGNATURE_BYTES * 2 || payerAddress === undefined) {
    return undefined;
  }
  // FiatToken checks the signer against `from`: a payer other than `from`
  // would store a signature the contract reverts on.
  if (normalizeEvmAddress(typedData.message.from) !== payerAddress) {
    return undefined;
  }
  const r = BigInt(`0x${data.slice(2, 66)}`);
  let s = BigInt(`0x${data.slice(66, 130)}`);
  const vByte = Number.parseInt(data.slice(130, 132), 16);
  // Wallets write v as 27/28; some write the bare recovery id 0/1.
  let recovery = vByte >= 27 ? vByte - 27 : vByte;
  if (recovery !== 0 && recovery !== 1) {
    return undefined;
  }
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) {
    return undefined;
  }
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    recovery = 1 - recovery;
  }
  const rHex = r.toString(16).padStart(WORD_HEX_CHARS, '0');
  const sHex = s.toString(16).padStart(WORD_HEX_CHARS, '0');
  let recovered: string;
  try {
    // noble's 'recovered' format puts the recovery id FIRST: [v, r, s].
    const publicKey = secp256k1.recoverPublicKey(
      hexToBytes(`0${recovery}${rHex}${sHex}`),
      hexToBytes(hashTransferAuthorization(typedData).slice(2)),
      { prehash: false },
    );
    recovered = addressOfPublicKey(publicKey);
  } catch {
    return undefined;
  }
  if (recovered !== payerAddress) {
    return undefined;
  }
  return `0x${rHex}${sHex}${(27 + recovery).toString(16)}`;
}

/**
 * Calldata of the BYTES overload (`0xcf092995`) for one authorization and its
 * signature. Refuses an ERC-6492-wrapped signature (an undeployed smart wallet:
 * FiatToken does not unwrap it), anything that is not 65 bytes, and a value,
 * validAfter or validBefore that is not a decimal uint256.
 */
export function encodeTransferWithAuthorization(
  message: TransferAuthorizationMessage,
  signature: string,
): string {
  const data = readHexData(signature);
  if (data === null) {
    throw new Error('The signature is not hex.');
  }
  if (data.endsWith(ERC6492_MAGIC)) {
    throw new Error('An ERC-6492 signature cannot pay: FiatToken does not unwrap it.');
  }
  if (data.length !== 2 + SIGNATURE_BYTES * 2) {
    throw new Error('The signature must be 65 bytes.');
  }
  const from = requireAddress(message.from, 'from');
  const to = requireAddress(message.to, 'to');
  const nonce = requireNonce(message.nonce);
  const value = requireUint256(message.value, 'value');
  const validAfter = requireUint256(message.validAfter, 'validAfter');
  const validBefore = requireUint256(message.validBefore, 'validBefore');
  // Seven head words, then the bytes: the offset of the signature is 7 * 32.
  const signatureBody = data.slice(2).padEnd(WORD_HEX_CHARS * 3, '0');
  return (
    TRANSFER_WITH_AUTHORIZATION_SELECTOR +
    addressWord(from) +
    addressWord(to) +
    wordOf(value) +
    wordOf(validAfter) +
    wordOf(validBefore) +
    nonce.slice(2) +
    wordOf(7n * 32n) +
    wordOf(BigInt(SIGNATURE_BYTES)) +
    signatureBody
  );
}

/** The call is INSIDE the try: a provider that validates its params synchronously throws before there is a promise. */
async function requestOrUndefined(
  client: Eip1193Client,
  method: string,
  params: readonly unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await withAbort(client.request({ method, params }), signal);
  } catch {
    return undefined;
  }
}

function blockParam(block: 'latest' | PinnedBlock): unknown {
  if (block === 'latest') {
    return 'latest';
  }
  return { blockHash: requireHash(block.blockHash, 'block'), requireCanonical: true };
}

async function callWords(
  client: Eip1193Client,
  to: string,
  data: string,
  count: number,
  block: 'latest' | PinnedBlock = 'latest',
): Promise<string[] | null> {
  return readWords(
    await requestOrUndefined(client, 'eth_call', [{ to, data }, blockParam(block)]),
    count,
  );
}

function readBool(words: string[] | null): boolean | null {
  const value = readUint256(words?.[0]);
  if (value === 0n) {
    return false;
  }
  return value === 1n ? true : null;
}

/** The contract's own `DOMAIN_SEPARATOR()`, at `latest`, or `null`. */
export async function readDomainSeparator(
  client: Eip1193Client,
  asset: Asset,
): Promise<string | null> {
  const coin = requireCoin(asset);
  const words = await callWords(client, coin.mint, DOMAIN_SEPARATOR_SELECTOR, 1);
  return words === null ? null : `0x${words[0]}`;
}

/**
 * The block a tag resolves to: number, hash and timestamp, or `null`. The
 * order's chain time, `too_late`, the authorization's `validBefore` and the
 * send margin read `latest`; the node's head reads `safe`; the end proof's `F`
 * reads `finalized`.
 */
export async function readBlockAtTag(
  client: Eip1193Client,
  tag: BlockTag,
): Promise<Eip3009BlockRef | null> {
  const block = await requestOrUndefined(client, 'eth_getBlockByNumber', [tag, false]);
  const number = readBlockNumber(readField(block, 'number'));
  const timestamp = readBlockNumber(readField(block, 'timestamp'));
  const hash = readTxHash(readField(block, 'hash'));
  if (number === null || timestamp === null || hash === null) {
    return null;
  }
  return { number, hash, timestamp };
}

/** `readBlockAtTag(client, 'finalized')`: the end proof's `F`. */
export async function readFinalizedBlockWithHash(
  client: Eip1193Client,
): Promise<Eip3009BlockRef | null> {
  return await readBlockAtTag(client, 'finalized');
}

/** Whether `eth_chainId` NAMES `chain` - an answer, not merely no contradiction. */
async function namesChain(client: Eip1193Client, chain: ChainConfig): Promise<boolean> {
  try {
    return (await checkEvmChain(client, chain)) !== null;
  } catch {
    return false;
  }
}

export type AuthorizationState = 'used' | 'unused' | 'unreadable';

/**
 * `authorizationState(authorizer, nonce)` - used OR canceled - at `latest`, or
 * PINNED to a block by EIP-1898 `{ blockHash, requireCanonical: true }` (the end
 * proof). A pinned read cannot be answered by a backend whose head is below
 * that block. Before `unused` is returned, `eth_chainId` is read again and must
 * name `chain`: "not paid" is never said about another chain. An error is
 * `unreadable`, never `unused`.
 */
export async function readAuthorizationUsed(
  client: Eip1193Client,
  chain: ChainConfig,
  asset: Asset,
  authorizer: string,
  nonce: string,
  block: 'latest' | PinnedBlock,
): Promise<AuthorizationState> {
  const coin = requireCoin(asset, chain);
  const owner = requireAddress(authorizer, 'authorizer');
  const word = requireNonce(nonce);
  const used = readBool(
    await callWords(
      client,
      coin.mint,
      `${AUTHORIZATION_STATE_SELECTOR}${addressWord(owner)}${word.slice(2)}`,
      1,
      block,
    ),
  );
  if (used === null) {
    return 'unreadable';
  }
  if (used) {
    return 'used';
  }
  return (await namesChain(client, coin.chain)) ? 'unused' : 'unreadable';
}

export interface Eip3009RangeOptions {
  /** Blocks per `eth_getLogs` call. Default: the chain's registry `logRangeCap`. */
  rangeCap?: number;
  signal?: AbortSignal;
}

interface LogFields {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
}

/** The fields every log carries, or `null` (a removed log included). */
function readLogFields(entry: unknown): LogFields | null {
  if (readField(entry, 'removed') === true) {
    return null;
  }
  const address = normalizeEvmAddress(readField(entry, 'address')) ?? null;
  const rawTopics = readField(entry, 'topics');
  const data = readHexData(readField(entry, 'data'));
  const transactionHash = readTxHash(readField(entry, 'transactionHash'));
  const logIndex = readBlockNumber(readField(entry, 'logIndex'));
  const blockNumber = readBlockNumber(readField(entry, 'blockNumber'));
  const blockHash = readTxHash(readField(entry, 'blockHash'));
  if (
    address === null ||
    !Array.isArray(rawTopics) ||
    data === null ||
    transactionHash === null ||
    logIndex === null ||
    blockNumber === null ||
    blockHash === null
  ) {
    return null;
  }
  const topics: string[] = [];
  for (const topic of rawTopics) {
    const word = readTopicWord(topic);
    if (word === null) {
      return null;
    }
    topics.push(word);
  }
  return { address, topics, data, transactionHash, logIndex, blockNumber, blockHash };
}

/** Where a log sits: the transaction, the block and the position. */
export interface Eip3009LogRef {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
}

/** A USDC `Transfer`, decoded. */
export interface Eip3009TransferLog extends Eip3009LogRef {
  from: string;
  to: string;
  value: bigint;
}

/** An `AuthorizationUsed` or `AuthorizationCanceled`, decoded. */
export interface Eip3009AuthorizationLog extends Eip3009LogRef {
  authorizer: string;
  nonce: string;
}

function refOf(fields: LogFields): Eip3009LogRef {
  return {
    txHash: fields.transactionHash,
    blockNumber: fields.blockNumber,
    blockHash: fields.blockHash,
    logIndex: fields.logIndex,
  };
}

/** A `Transfer` from `token`, whole, or `null`: three topics, clean addresses, one word of data. */
function decodeTransfer(fields: LogFields, token: string): Eip3009TransferLog | null {
  if (
    fields.address !== token ||
    fields.topics.length !== 3 ||
    fields.topics[0] !== TRANSFER_TOPIC
  ) {
    return null;
  }
  const from = readTopicAddress(fields.topics[1]);
  const to = readTopicAddress(fields.topics[2]);
  const value = readUint256(readWords(fields.data, 1)?.[0]);
  if (from === null || to === null || value === null) {
    return null;
  }
  return { ...refOf(fields), from, to, value };
}

/** An authorization event of `topic` from `token`, whole, or `null`. */
function decodeAuthorization(
  fields: LogFields,
  token: string,
  topic: string,
): Eip3009AuthorizationLog | null {
  if (
    fields.address !== token ||
    fields.topics.length !== 3 ||
    fields.topics[0] !== topic ||
    fields.data !== '0x'
  ) {
    return null;
  }
  const authorizer = readTopicAddress(fields.topics[1]);
  const nonce = fields.topics[2];
  if (authorizer === null || nonce === undefined) {
    return null;
  }
  return { ...refOf(fields), authorizer, nonce };
}

export type LogWalk<T> =
  | { complete: true; logs: T[]; requests: number }
  | { complete: false; requests: number };

interface LogWalkRequest {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
  rangeCap: number;
  signal?: AbortSignal;
}

function rangeCapOf(coin: Eip3009Coin, options?: Eip3009RangeOptions): number {
  const cap = options?.rangeCap ?? coin.chain.logRangeCap;
  if (cap === undefined || !Number.isInteger(cap) || cap < 1) {
    throw new Error('A log range cap must be a whole number of blocks, at least 1.');
  }
  return cap;
}

function requireRange(fromBlock: number, toBlock: number): void {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0) {
    throw new Error('A block range needs whole, non-negative block numbers.');
  }
}

/**
 * `[fromBlock, toBlock]` in chunks of at most `rangeCap` blocks, halving a chunk
 * the node calls too much. COMPLETE OR AN ERROR: any chunk that fails for
 * another reason, any answer that is not a list, and any entry that does not
 * decode as what was asked for ends the walk incomplete - never a silent
 * partial list. A reversed range (`fromBlock > toBlock`, e.g. a head read from
 * a lagging backend below the caller's floor) is incomplete with no request,
 * as Tempo's `listTempoMarkedTransfers`: nothing was looked at, so it must not
 * read as "looked, nothing". Every request made is counted, the halvings
 * included.
 */
async function walkLogs<T>(
  client: Eip1193Client,
  request: LogWalkRequest,
  decode: (fields: LogFields) => T | null,
): Promise<LogWalk<T>> {
  const logs: T[] = [];
  let cursor = request.fromBlock;
  let size = request.rangeCap;
  let requests = 0;
  if (request.fromBlock > request.toBlock) {
    return { complete: false, requests };
  }
  while (cursor <= request.toBlock) {
    if (request.signal?.aborted || requests >= MAX_LOG_SCAN_REQUESTS) {
      return { complete: false, requests };
    }
    requests += 1;
    const chunkTo = Math.min(cursor + size - 1, request.toBlock);
    let result: unknown;
    try {
      result = await withAbort(
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: request.address,
              topics: request.topics,
              fromBlock: toQuantity(cursor),
              toBlock: toQuantity(chunkTo),
            },
          ],
        }),
        request.signal,
      );
    } catch (error) {
      if (isTooMuchError(error) && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      return { complete: false, requests };
    }
    if (!Array.isArray(result)) {
      return { complete: false, requests };
    }
    for (const entry of result) {
      const fields = readLogFields(entry);
      const decoded = fields === null ? null : decode(fields);
      if (
        fields === null ||
        decoded === null ||
        fields.blockNumber < cursor ||
        fields.blockNumber > chunkTo
      ) {
        return { complete: false, requests };
      }
      logs.push(decoded);
    }
    cursor = chunkTo + 1;
  }
  return { complete: true, logs, requests };
}

export type AuthorizationCanceledScan =
  | { state: 'canceled' | 'not_canceled'; requests: number }
  | { state: 'unreadable'; requests: number };

/**
 * Whether an `AuthorizationCanceled` log exists for `(authorizer, nonce)` in
 * `[fromBlock, toBlock]` - the end proof's cancel branch. Complete or
 * `unreadable`, never "not canceled" on a partial walk.
 */
export async function readAuthorizationCanceled(
  client: Eip1193Client,
  asset: Asset,
  authorizer: string,
  nonce: string,
  fromBlock: number,
  toBlock: number,
  options?: Eip3009RangeOptions,
): Promise<AuthorizationCanceledScan> {
  const coin = requireCoin(asset);
  const owner = requireAddress(authorizer, 'authorizer');
  const word = requireNonce(nonce);
  requireRange(fromBlock, toBlock);
  const walk = await walkLogs(
    client,
    {
      address: coin.mint,
      topics: [AUTHORIZATION_CANCELED_TOPIC, addressTopic(owner), word],
      fromBlock,
      toBlock,
      rangeCap: rangeCapOf(coin, options),
      signal: options?.signal,
    },
    (fields) => {
      const decoded = decodeAuthorization(fields, coin.mint, AUTHORIZATION_CANCELED_TOPIC);
      return decoded !== null && decoded.authorizer === owner && decoded.nonce === word
        ? decoded
        : null;
    },
  );
  if (!walk.complete) {
    return { state: 'unreadable', requests: walk.requests };
  }
  return {
    state: walk.logs.length > 0 ? 'canceled' : 'not_canceled',
    requests: walk.requests,
  };
}

/**
 * USDC `Transfer`s to `payout` (`topics[2]`, ONE value) in `[fromBlock,
 * toBlock]` - the node's scan. Complete or incomplete, never a silent partial
 * list. A zero-value transfer is listed like any other: dropping what is free to
 * forge is the caller's rule.
 */
export async function listPayoutTransfers(
  client: Eip1193Client,
  asset: Asset,
  payout: string,
  fromBlock: number,
  toBlock: number,
  options?: Eip3009RangeOptions,
): Promise<LogWalk<Eip3009TransferLog>> {
  const coin = requireCoin(asset);
  const to = requireAddress(payout, 'payout');
  requireRange(fromBlock, toBlock);
  return await walkLogs(
    client,
    {
      address: coin.mint,
      topics: [TRANSFER_TOPIC, null, addressTopic(to)],
      fromBlock,
      toBlock,
      rangeCap: rangeCapOf(coin, options),
      signal: options?.signal,
    },
    (fields) => {
      const decoded = decodeTransfer(fields, coin.mint);
      return decoded !== null && decoded.to === to ? decoded : null;
    },
  );
}

/**
 * `AuthorizationUsed` logs with `topics[2]` = one nonce in `[fromBlock,
 * toBlock]` - the widget's scan for its own order. Complete or incomplete,
 * never a silent partial list.
 */
export async function listAuthorizationsByNonce(
  client: Eip1193Client,
  asset: Asset,
  nonce: string,
  fromBlock: number,
  toBlock: number,
  options?: Eip3009RangeOptions,
): Promise<LogWalk<Eip3009AuthorizationLog>> {
  const coin = requireCoin(asset);
  const word = requireNonce(nonce);
  requireRange(fromBlock, toBlock);
  return await walkLogs(
    client,
    {
      address: coin.mint,
      topics: [AUTHORIZATION_USED_TOPIC, null, word],
      fromBlock,
      toBlock,
      rangeCap: rangeCapOf(coin, options),
      signal: options?.signal,
    },
    (fields) => {
      const decoded = decodeAuthorization(fields, coin.mint, AUTHORIZATION_USED_TOPIC);
      return decoded !== null && decoded.nonce === word ? decoded : null;
    },
  );
}

export type AssetTransferNear =
  | { state: 'found'; log: Eip3009TransferLog; requests: number }
  | { state: 'none' | 'unreadable'; requests: number };

/**
 * The first USDC `Transfer` (no topic filter) in `[fromBlock, fromBlock + cap -
 * 1]`: the node start check's first step. The window is walked forward in chunks
 * that double from 1 block, a chunk halving on a too-much answer; `none` only
 * once the whole window answered empty, `unreadable` on anything else.
 */
export async function findAssetTransferNear(
  client: Eip1193Client,
  asset: Asset,
  fromBlock: number,
  cap: number,
): Promise<AssetTransferNear> {
  const coin = requireCoin(asset);
  requireRange(fromBlock, fromBlock);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error('The search cap must be a whole number of blocks, at least 1.');
  }
  const last = fromBlock + cap - 1;
  let cursor = fromBlock;
  let span = 1;
  let requests = 0;
  while (cursor <= last) {
    if (requests >= MAX_LOG_SCAN_REQUESTS) {
      return { state: 'unreadable', requests };
    }
    requests += 1;
    const chunkTo = Math.min(cursor + span - 1, last);
    let result: unknown;
    try {
      result = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: coin.mint,
            topics: [TRANSFER_TOPIC],
            fromBlock: toQuantity(cursor),
            toBlock: toQuantity(chunkTo),
          },
        ],
      });
    } catch (error) {
      if (isTooMuchError(error) && span > 1) {
        span = Math.max(1, Math.floor(span / 2));
        continue;
      }
      return { state: 'unreadable', requests };
    }
    if (!Array.isArray(result)) {
      return { state: 'unreadable', requests };
    }
    const [first] = result;
    if (first !== undefined) {
      const fields = readLogFields(first);
      const decoded = fields === null ? null : decodeTransfer(fields, coin.mint);
      if (decoded === null || decoded.blockNumber < cursor || decoded.blockNumber > chunkTo) {
        return { state: 'unreadable', requests };
      }
      return { state: 'found', log: decoded, requests };
    }
    cursor = chunkTo + 1;
    span *= 2;
  }
  return { state: 'none', requests };
}

interface TrustedReceipt {
  status: bigint;
  blockNumber: number;
  blockHash: string;
  logs: LogFields[];
}

type ReceiptRead =
  | { kind: 'receipt'; receipt: TrustedReceipt }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/**
 * A receipt by hash under the verifier's trust rules: it must be the receipt
 * ASKED for (`transactionHash`), whole, and its block must be the block this
 * endpoint holds at that height. A null answer is `absent`.
 */
async function readTrustedReceipt(client: Eip1193Client, hash: string): Promise<ReceiptRead> {
  const read = await readWholeReceipt(client, hash);
  if (read.kind !== 'receipt') {
    return read;
  }
  const { blockNumber, blockHash } = read.receipt;
  return (await isOnThisChain(client, blockNumber, blockHash)) ? read : { kind: 'unreadable' };
}

/** {@link readTrustedReceipt} without the check that its block is on this chain. */
async function readWholeReceipt(client: Eip1193Client, hash: string): Promise<ReceiptRead> {
  const receipt = await requestOrUndefined(client, 'eth_getTransactionReceipt', [hash]);
  if (receipt === null) {
    return { kind: 'absent' };
  }
  if (receipt === undefined || readTxHash(readField(receipt, 'transactionHash')) !== hash) {
    return { kind: 'unreadable' };
  }
  const status = readQuantity(readField(receipt, 'status'));
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  const blockHash = readTxHash(readField(receipt, 'blockHash'));
  const rawLogs = readField(receipt, 'logs');
  if (
    (status !== 0n && status !== 1n) ||
    blockNumber === null ||
    blockHash === null ||
    !Array.isArray(rawLogs)
  ) {
    return { kind: 'unreadable' };
  }
  const logs: LogFields[] = [];
  for (const entry of rawLogs) {
    const fields = readLogFields(entry);
    if (fields === null) {
      return { kind: 'unreadable' };
    }
    // A log that names another transaction or block is not this receipt's.
    if (
      fields.transactionHash !== hash ||
      fields.blockNumber !== blockNumber ||
      fields.blockHash !== blockHash
    ) {
      return { kind: 'unreadable' };
    }
    logs.push(fields);
  }
  return { kind: 'receipt', receipt: { status, blockNumber, blockHash, logs } };
}

export interface Eip3009Leg extends Eip3009LogRef {
  authorizer: string;
  value: bigint;
}

export type Eip3009Legs =
  | { state: 'unreadable' | 'absent' }
  | {
      state: 'none';
      blockNumber: number;
      blockHash: string;
      /** At or below the credit tag: the answer cannot change but by a deep reorg. */
      final: boolean;
    }
  | { state: 'pending' | 'paid'; leg: Eip3009Leg };

export interface ReadEip3009LegsOptions {
  chain: ChainConfig;
  asset: Asset;
  /** The order's nonce. */
  nonce: string;
  /** The payee. */
  to: string;
  /** The smallest value that counts, in subunits: at least 1. */
  minValue: bigint;
  /**
   * `latest`: a leg is `paid` as soon as its block is on this chain, without
   * waiting for the credit tag (a reorg can still drop it). `none` stays
   * `final` only at or below the credit tag either way. Default: the chain's
   * credit tag.
   */
  paidAt?: 'latest';
}

/**
 * The leg of one order in one transaction, by hash.
 *
 * It MATCHES only as an `AuthorizationUsed` from the USDC proxy with that nonce,
 * IMMEDIATELY followed (log index + 1, same proxy) by a `Transfer` whose `from`
 * is that authorizer, `to` the payee and value at least `minValue`. Anything
 * else in the receipt is ignored. `paid` once the block is at or below the
 * chain's credit tag (with `paidAt: 'latest'`, as soon as the block is on this
 * chain), `pending` above it; `none` for a reverted transaction or
 * one without the leg, `final` only at or below the credit tag (above it a
 * reorg can still land another transaction there); `absent` when the node has
 * no such transaction; `unreadable` for anything else. The credit tag is read
 * BEFORE the receipt's block is checked to be on this chain (as Tempo's
 * receipt legs do), so a block replaced while the tag moves is caught.
 * `eth_chainId` must name the chain before `paid` or `none`.
 */
export async function readEip3009Legs(
  client: Eip1193Client,
  hash: string,
  options: ReadEip3009LegsOptions,
): Promise<Eip3009Legs> {
  const { chain } = options;
  const coin = requireCoin(options.asset, chain);
  const nonce = requireNonce(options.nonce);
  const to = requireAddress(options.to, 'to');
  if (typeof options.minValue !== 'bigint' || options.minValue < 1n) {
    throw new Error('A leg needs a minimum of at least 1 subunit.');
  }
  const credit = coin.chain.finality?.credit;
  if (credit === undefined) {
    throw new Error('The chain has no credit tag.');
  }
  const txHash = readTxHash(hash);
  if (txHash === null) {
    throw new Error('Not a transaction hash.');
  }
  const read = await readWholeReceipt(client, txHash);
  if (read.kind !== 'receipt') {
    return { state: read.kind };
  }
  const { receipt } = read;
  const tagBlock = await readBlockAtTag(client, credit);
  if (tagBlock === null || !(await isOnThisChain(client, receipt.blockNumber, receipt.blockHash))) {
    return { state: 'unreadable' };
  }
  const atTag = receipt.blockNumber <= tagBlock.number;
  const leg =
    receipt.status === 1n ? matchLeg(receipt.logs, coin.mint, nonce, to, options.minValue) : null;
  if (leg !== null && !atTag && options.paidAt !== 'latest') {
    return { state: 'pending', leg };
  }
  if (!(await namesChain(client, coin.chain))) {
    return { state: 'unreadable' };
  }
  if (leg === null) {
    return {
      state: 'none',
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      final: atTag,
    };
  }
  return { state: 'paid', leg };
}

function matchLeg(
  logs: readonly LogFields[],
  token: string,
  nonce: string,
  to: string,
  minValue: bigint,
): Eip3009Leg | null {
  for (const fields of logs) {
    const used = decodeAuthorization(fields, token, AUTHORIZATION_USED_TOPIC);
    if (used === null || used.nonce !== nonce) {
      continue;
    }
    const next = logs.find((candidate) => candidate.logIndex === fields.logIndex + 1);
    if (next === undefined) {
      continue;
    }
    const transfer = decodeTransfer(next, token);
    if (
      transfer !== null &&
      transfer.from === used.authorizer &&
      transfer.to === to &&
      transfer.value >= minValue
    ) {
      return { ...refOf(next), authorizer: used.authorizer, value: transfer.value };
    }
  }
  return null;
}

export type AuthorizationBinding =
  | { state: 'bound'; authorizer: string; nonce: string }
  | { state: 'unbound' | 'unreadable' };

/**
 * The node's binding read for a `Transfer` hit of its scan: the hit's receipt by
 * hash under the verifier's trust rules, its block hash and number equal to the
 * hit log's, the hit itself at its index, and the log at index - 1 an
 * `AuthorizationUsed` from the same proxy whose authorizer is the `Transfer`'s
 * `from`. A null receipt, a hash mismatch or a block mismatch is `unreadable`
 * (log and receipt may come from different forks or backends: never cached);
 * `unbound` only for a trusted receipt whose index - 1 log is missing, is not
 * an `AuthorizationUsed` from the proxy, or names another authorizer.
 */
export async function readAuthorizationBinding(
  client: Eip1193Client,
  chain: ChainConfig,
  asset: Asset,
  hit: Eip3009TransferLog,
): Promise<AuthorizationBinding> {
  const coin = requireCoin(asset, chain);
  const txHash = requireHash(hit.txHash, 'transaction');
  const blockHash = requireHash(hit.blockHash, 'block');
  const from = requireAddress(hit.from, 'from');
  const to = requireAddress(hit.to, 'to');
  const read = await readTrustedReceipt(client, txHash);
  if (read.kind !== 'receipt') {
    return { state: 'unreadable' };
  }
  const { receipt } = read;
  if (
    receipt.status !== 1n ||
    receipt.blockHash !== blockHash ||
    receipt.blockNumber !== hit.blockNumber
  ) {
    return { state: 'unreadable' };
  }
  const own = receipt.logs.find((fields) => fields.logIndex === hit.logIndex);
  const ownTransfer = own === undefined ? null : decodeTransfer(own, coin.mint);
  if (
    ownTransfer === null ||
    ownTransfer.from !== from ||
    ownTransfer.to !== to ||
    ownTransfer.value !== hit.value
  ) {
    return { state: 'unreadable' };
  }
  if (!(await namesChain(client, coin.chain))) {
    return { state: 'unreadable' };
  }
  const previous = receipt.logs.find((fields) => fields.logIndex === hit.logIndex - 1);
  const used =
    previous === undefined
      ? null
      : decodeAuthorization(previous, coin.mint, AUTHORIZATION_USED_TOPIC);
  if (used === null || used.authorizer !== from) {
    return { state: 'unbound' };
  }
  return { state: 'bound', authorizer: used.authorizer, nonce: used.nonce };
}

/** The code at a payer, classified for the 7702 rule. */
export type PayerCode =
  | { kind: 'none' }
  | { kind: 'delegated'; delegate: string; known: boolean }
  | { kind: 'other' };

export type Eip3009Preflight =
  | {
      ok: true;
      paused: boolean;
      payerBlacklisted: boolean;
      payeeBlacklisted: boolean;
      /** USDC subunits. */
      tokenBalance: bigint;
      /** Native coin, wei. */
      nativeBalance: bigint;
      payerCode: PayerCode;
      domainSeparator: string;
      domainMatches: boolean;
      implementation: string;
      implementationMatches: boolean;
    }
  | { ok: false };

function classifyCode(code: string, knownDelegates: readonly string[]): PayerCode {
  if (code === '0x') {
    return { kind: 'none' };
  }
  if (code.startsWith(DELEGATION_DESIGNATOR_PREFIX) && code.length === 2 + 23 * 2) {
    const delegate = `0x${code.slice(DELEGATION_DESIGNATOR_PREFIX.length)}`;
    return {
      kind: 'delegated',
      delegate,
      known: knownDelegates.some((known) => sameAddress(known, delegate)),
    };
  }
  return { kind: 'other' };
}

/**
 * Everything step 2 reads from the chain before a signature, in one place, at
 * `latest`: `paused()`, `isBlacklisted` of payer and payee, the USDC and native
 * balances, the payer's code (none, a 7702 designator and its delegate, other),
 * the domain separator against the registry's, and the proxy's implementation
 * slot against the pinned one. ANY failed read is `{ ok: false }`, never a pass.
 */
export async function readEip3009Preflight(
  client: Eip1193Client,
  chain: ChainConfig,
  asset: Asset,
  payer: string,
  payee: string,
): Promise<Eip3009Preflight> {
  const coin = requireCoin(asset, chain);
  const payerAddress = requireAddress(payer, 'payer');
  const payeeAddress = requireAddress(payee, 'payee');
  const pinned = coin.implementation;
  if (pinned === undefined || !isEvmAddressFormat(pinned)) {
    throw new Error('The asset has no pinned implementation.');
  }
  const [paused, payerListed, payeeListed, balanceWords, native, code, domain, implementation] =
    await Promise.all([
      callWords(client, coin.mint, PAUSED_SELECTOR, 1),
      callWords(client, coin.mint, `${IS_BLACKLISTED_SELECTOR}${addressWord(payerAddress)}`, 1),
      callWords(client, coin.mint, `${IS_BLACKLISTED_SELECTOR}${addressWord(payeeAddress)}`, 1),
      callWords(client, coin.mint, `${BALANCE_OF_SELECTOR}${addressWord(payerAddress)}`, 1),
      requestOrUndefined(client, 'eth_getBalance', [payerAddress, 'latest']),
      requestOrUndefined(client, 'eth_getCode', [payerAddress, 'latest']),
      callWords(client, coin.mint, DOMAIN_SEPARATOR_SELECTOR, 1),
      readImplementation(client, asset, 'latest'),
    ]);
  const pausedFlag = readBool(paused);
  const payerBlacklisted = readBool(payerListed);
  const payeeBlacklisted = readBool(payeeListed);
  const tokenBalance = readUint256(balanceWords?.[0]);
  const nativeBalance = readQuantity(native);
  const codeHex = readHexData(code);
  const domainWord = domain?.[0];
  if (
    pausedFlag === null ||
    payerBlacklisted === null ||
    payeeBlacklisted === null ||
    tokenBalance === null ||
    nativeBalance === null ||
    codeHex === null ||
    domainWord === undefined ||
    implementation === null
  ) {
    return { ok: false };
  }
  const domainSeparator = `0x${domainWord}`;
  return {
    ok: true,
    paused: pausedFlag,
    payerBlacklisted,
    payeeBlacklisted,
    tokenBalance,
    nativeBalance,
    payerCode: classifyCode(codeHex, coin.chain.knownDelegates ?? []),
    domainSeparator,
    domainMatches: domainSeparator === expectedDomainSeparator(chain, asset),
    implementation,
    implementationMatches: sameAddress(implementation, pinned),
  };
}

/**
 * The proxy's implementation (the zeppelinos slot, `eth_getStorageAt`), at
 * `latest` or pinned by EIP-1898 `{ blockHash, requireCanonical: true }`, or
 * `null` when it cannot be read. `null` is an error, never a match.
 */
export async function readImplementation(
  client: Eip1193Client,
  asset: Asset,
  block: 'latest' | PinnedBlock,
): Promise<string | null> {
  const coin = requireCoin(asset);
  const slot = readWords(
    await requestOrUndefined(client, 'eth_getStorageAt', [
      coin.mint,
      FIAT_TOKEN_IMPLEMENTATION_SLOT,
      blockParam(block),
    ]),
    1,
  );
  return readAddressWord(slot?.[0]);
}

export type GasEstimate =
  | { kind: 'ok'; gas: bigint; feeCap: bigint }
  | { kind: 'execution_error' }
  | { kind: 'transport_error' };

function isExecutionError(error: unknown): boolean {
  const code = readField(error, 'code');
  return typeof code === 'number' && EXECUTION_ERROR_CODES.includes(code);
}

/**
 * `eth_estimateGas` of the signed call (`from` = payer, `to` = USDC) at
 * `latest`, WITHOUT fee fields - so geth, op-geth and Nitro skip their balance
 * check and the estimate prices the call, not the payer's wallet - and the fee
 * cap `2 x latest baseFeePerGas + eth_maxPriorityFeePerGas`. A JSON-RPC
 * execution error of the estimate is kept apart from a transport failure of any
 * of the three reads.
 */
export async function estimateTransferWithAuthorization(
  client: Eip1193Client,
  chain: ChainConfig,
  payer: string,
  calldata: string,
): Promise<GasEstimate> {
  const known = requireEip3009Chain(chain);
  const coin = requireCoin(defaultCoinOf(known), known);
  const from = requireAddress(payer, 'payer');
  const data = readHexData(calldata);
  if (data === null) {
    throw new Error('The calldata is not hex.');
  }
  let estimate: unknown;
  try {
    estimate = await client.request({
      method: 'eth_estimateGas',
      params: [{ from, to: coin.mint, data }, 'latest'],
    });
  } catch (error) {
    return isExecutionError(error) ? { kind: 'execution_error' } : { kind: 'transport_error' };
  }
  const gas = readQuantity(estimate);
  const [block, priority] = await Promise.all([
    requestOrUndefined(client, 'eth_getBlockByNumber', ['latest', false]),
    requestOrUndefined(client, 'eth_maxPriorityFeePerGas', []),
  ]);
  const baseFee = readQuantity(readField(block, 'baseFeePerGas'));
  const priorityFee = readQuantity(priority);
  if (gas === null || baseFee === null || priorityFee === null) {
    return { kind: 'transport_error' };
  }
  return { kind: 'ok', gas, feeCap: 2n * baseFee + priorityFee };
}

function defaultCoinOf(chain: ChainConfig): Asset {
  const [coin] = assetsFor(chain.slug, chain.network);
  if (coin === undefined) {
    throw new Error('The chain has no coin.');
  }
  return coin;
}

/**
 * The OP-stack `getL1Fee` of `calldata`, in wei - the L1 data part of a Base
 * transaction's cost. Only for a chain with `l1FeeOracle`; `null` when the read
 * fails, which is an error, never 0.
 */
export async function readL1Fee(
  client: Eip1193Client,
  chain: ChainConfig,
  calldata: string,
): Promise<bigint | null> {
  const oracle = requireEip3009Chain(chain).l1FeeOracle;
  if (oracle === undefined) {
    throw new Error('The chain has no L1 fee oracle.');
  }
  const data = readHexData(calldata);
  if (data === null) {
    throw new Error('The calldata is not hex.');
  }
  const body = data.slice(2);
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(body.length / WORD_HEX_CHARS) * WORD_HEX_CHARS, '0');
  const words = await callWords(
    client,
    oracle,
    `${GET_L1_FEE_SELECTOR}${wordOf(32n)}${wordOf(BigInt(length))}${padded}`,
    1,
  );
  return readUint256(words?.[0]);
}
