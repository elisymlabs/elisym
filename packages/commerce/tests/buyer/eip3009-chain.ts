/**
 * A fake EIP-3009 chain (one USDC proxy, its blocks, receipts and logs) and a
 * fake EIP-1193 wallet that signs typed data with a real key, for the buyer
 * core's tests.
 */
import type { Asset, ChainConfig } from '@elisym/pay-core';
import {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_USED_TOPIC,
  type Eip1193Client,
  FIAT_TOKEN_IMPLEMENTATION_SLOT,
  type TransferAuthorizationTypedData,
  buildTransferAuthorization,
  expectedDomainSeparator,
  hashTransferAuthorization,
  normalizeAuthorizationSignature,
} from '@elisym/pay-core/evm';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Eip3009Wallet } from '../../src/buyer/eip3009-pay';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

export function hexNumber(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

export function blockHashOf(number: number): string {
  return `0x${'b'.repeat(56)}${number.toString(16).padStart(8, '0')}`;
}

export function addressOf(secret: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(secret, false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(12))}`;
}

function topicOf(address: string): string {
  return `0x${word(address.toLowerCase())}`;
}

interface Block {
  number: number;
  timestamp: number;
}

export interface FakeChain {
  client: Eip1193Client;
  chain: ChainConfig;
  asset: Asset;
  /** The proxy, lowercase. */
  mint: string;
  /** What `eth_chainId` of the widget RPC answers. */
  chainId: number;
  latest: Block;
  safe: Block;
  finalized: Block;
  /** `authorizer:nonce` used at `latest`. */
  used: Set<string>;
  /**
   * `authorizer:nonce` used at the finalized block, read pinned by its hash;
   * `undefined` is the same as `used`. A read pinned to any other block hash
   * fails, as a node that does not hold that block does.
   */
  usedPinned: Set<string> | undefined;
  /** The block hash of every pinned read, in order. */
  pinnedReads: string[];
  paused: boolean;
  blacklisted: Set<string>;
  tokens: Map<string, bigint>;
  native: Map<string, bigint>;
  code: Map<string, string>;
  domain: string;
  implementation: string;
  /** The `eth_estimateGas` answer, or an error to throw. */
  estimate: () => bigint;
  baseFee: bigint;
  priority: bigint;
  l1Fee: bigint;
  receipts: Map<string, unknown>;
  logs: Record<string, unknown>[];
  calls: { method: string; params: readonly unknown[] }[];
  /** Methods that fail as a transport error. */
  down: Set<string>;
  /** One request that fails as a transport error (by method, selector, tag or count). */
  failIf: ((method: string, params: readonly unknown[]) => boolean) | undefined;
}

export function usedKey(authorizer: string, nonce: string): string {
  return `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`;
}

function topicMatches(filter: unknown, value: unknown): boolean {
  if (filter === null || filter === undefined) {
    return true;
  }
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

export function fakeChain(chain: ChainConfig, asset: Asset, now: number): FakeChain {
  const mint = (asset.mint ?? '').toLowerCase();
  const state: FakeChain = {
    client: { request: async () => undefined },
    chain,
    asset,
    mint,
    chainId: chain.evmChainId ?? 0,
    latest: { number: 1000, timestamp: now + 30 },
    safe: { number: 990, timestamp: now },
    finalized: { number: 950, timestamp: now - 900 },
    used: new Set(),
    usedPinned: undefined,
    pinnedReads: [],
    paused: false,
    blacklisted: new Set(),
    tokens: new Map(),
    native: new Map(),
    code: new Map(),
    domain: expectedDomainSeparator(chain, asset),
    implementation: asset.implementation ?? '',
    estimate: () => 100_000n,
    baseFee: 1_000_000_000n,
    priority: 100_000_000n,
    l1Fee: 1_000_000_000_000n,
    receipts: new Map(),
    logs: [],
    calls: [],
    down: new Set(),
    failIf: undefined,
  };
  const blockAt = (tag: unknown): Record<string, unknown> | null => {
    let block: Block;
    if (tag === 'latest') {
      block = state.latest;
    } else if (tag === 'safe') {
      block = state.safe;
    } else if (tag === 'finalized') {
      block = state.finalized;
    } else if (typeof tag === 'string' && tag.startsWith('0x')) {
      const number = Number.parseInt(tag, 16);
      const named = [state.latest, state.safe, state.finalized].find(
        (candidate) => candidate.number === number,
      );
      block = named ?? { number, timestamp: now };
    } else {
      return null;
    }
    return {
      number: hexNumber(block.number),
      hash: blockHashOf(block.number),
      timestamp: hexNumber(block.timestamp),
      baseFeePerGas: hexNumber(state.baseFee),
    };
  };
  /** The block a read names: `latest`, or the finalized block pinned by its hash (EIP-1898). */
  const pinnedAt = (block: unknown): 'latest' | 'finalized' => {
    if (block === 'latest') {
      return 'latest';
    }
    const pinned = block as { blockHash?: unknown; requireCanonical?: unknown } | undefined;
    if (typeof pinned?.blockHash !== 'string') {
      throw new Error(`unscripted block ${JSON.stringify(block)}`);
    }
    state.pinnedReads.push(pinned.blockHash);
    if (pinned.blockHash !== blockHashOf(state.finalized.number)) {
      throw { code: -32000, message: `header not found: ${pinned.blockHash}` };
    }
    return 'finalized';
  };
  const call = (params: readonly unknown[]): string => {
    const request = params[0] as { to: string; data: string };
    const at = pinnedAt(params[1]);
    const to = request.to.toLowerCase();
    const data = request.data;
    const selector = data.slice(0, 10);
    if (to === chain.l1FeeOracle?.toLowerCase() && selector === '0x49948e0e') {
      return `0x${word(state.l1Fee)}`;
    }
    if (to !== mint) {
      throw new Error(`no contract at ${to}`);
    }
    const addressArg = `0x${data.slice(34, 74)}`;
    switch (selector) {
      case '0xe94a0102': {
        const nonce = `0x${data.slice(74, 138)}`;
        const set = at === 'finalized' ? (state.usedPinned ?? state.used) : state.used;
        return `0x${word(set.has(usedKey(addressArg, nonce)) ? 1n : 0n)}`;
      }
      case '0x5c975abb':
        return `0x${word(state.paused ? 1n : 0n)}`;
      case '0xfe575a87':
        return `0x${word(state.blacklisted.has(addressArg) ? 1n : 0n)}`;
      case '0x70a08231':
        return `0x${word(state.tokens.get(addressArg) ?? 0n)}`;
      case '0x3644e515':
        return state.domain;
      default:
        throw new Error(`unknown call ${selector}`);
    }
  };
  const getLogs = (params: readonly unknown[]): unknown[] => {
    const filter = params[0] as {
      address: string;
      topics: unknown[];
      fromBlock: string;
      toBlock: string;
    };
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    return state.logs.filter((log) => {
      const number = Number.parseInt(String(log.blockNumber), 16);
      const topics = log.topics as string[];
      return (
        String(log.address) === filter.address.toLowerCase() &&
        number >= from &&
        number <= to &&
        filter.topics.every((topic, index) => topicMatches(topic, topics[index]))
      );
    });
  };
  state.client = {
    request: async ({ method, params = [] }) => {
      state.calls.push({ method, params });
      if (state.down.has(method) || state.failIf?.(method, params) === true) {
        throw new Error(`${method} is down`);
      }
      switch (method) {
        case 'eth_chainId':
          return hexNumber(state.chainId);
        case 'eth_getBlockByNumber':
          return blockAt(params[0]);
        case 'eth_call':
          return call(params);
        case 'eth_getBalance':
          pinnedAt(params[1]);
          return hexNumber(state.native.get(String(params[0]).toLowerCase()) ?? 0n);
        case 'eth_getCode':
          pinnedAt(params[1]);
          return state.code.get(String(params[0]).toLowerCase()) ?? '0x';
        case 'eth_getStorageAt':
          pinnedAt(params[2]);
          if (
            String(params[0]).toLowerCase() !== mint ||
            String(params[1]).toLowerCase() !== FIAT_TOKEN_IMPLEMENTATION_SLOT.toLowerCase()
          ) {
            return `0x${word(0n)}`;
          }
          return `0x${word(state.implementation)}`;
        case 'eth_estimateGas':
          requireValidAuthorization(state, params);
          return hexNumber(state.estimate());
        case 'eth_maxPriorityFeePerGas':
          return hexNumber(state.priority);
        case 'eth_getTransactionReceipt':
          return state.receipts.get(String(params[0])) ?? null;
        case 'eth_getLogs':
          return getLogs(params);
        default:
          throw new Error(`unscripted ${method}`);
      }
    },
  };
  return state;
}

const TRANSFER_WITH_AUTHORIZATION_SELECTOR = '0xcf092995';
const HEAD_WORDS = 8;

/**
 * As FiatToken does: the calldata must be the bytes overload to the proxy, and
 * its 65-byte signature must be the canonical one (v 27/28, low s) of the
 * authorizer over the call's own authorization. Anything else reverts.
 */
function requireValidAuthorization(state: FakeChain, params: readonly unknown[]): void {
  const request = params[0] as { to?: unknown; data?: unknown };
  const data = typeof request.data === 'string' ? request.data.toLowerCase() : '';
  const revert = (why: string): never => {
    throw { code: 3, message: `execution reverted: ${why}` };
  };
  if (String(request.to).toLowerCase() !== state.mint) {
    revert('not the USDC proxy');
  }
  if (!data.startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) {
    revert('not transferWithAuthorization(bytes)');
  }
  const body = data.slice(10);
  const wordAt = (index: number): string => body.slice(index * 64, index * 64 + 64);
  if (body.length < HEAD_WORDS * 64 + 130) {
    revert('short calldata');
  }
  const from = `0x${wordAt(0).slice(24)}`;
  const to = `0x${wordAt(1).slice(24)}`;
  const value = BigInt(`0x${wordAt(2)}`);
  const validAfter = BigInt(`0x${wordAt(3)}`);
  const validBefore = BigInt(`0x${wordAt(4)}`);
  const nonce = `0x${wordAt(5)}`;
  const length = Number(BigInt(`0x${wordAt(7)}`));
  const signature = `0x${body.slice(HEAD_WORDS * 64, HEAD_WORDS * 64 + length * 2)}`;
  if (validAfter !== 0n || length !== 65) {
    revert('malformed authorization');
  }
  const typed = buildTransferAuthorization({
    chain: state.chain,
    asset: state.asset,
    from,
    to,
    value,
    nonce,
    validBefore,
  });
  if (normalizeAuthorizationSignature(typed, signature, from) !== signature) {
    revert('FiatTokenV2: invalid signature');
  }
}

/** Land `hash` in `block`: `AuthorizationUsed(authorizer, nonce)` and the adjacent USDC `Transfer`. */
export function land(
  state: FakeChain,
  options: {
    hash: string;
    authorizer: string;
    nonce: string;
    payee: string;
    value: bigint;
    block: number;
  },
): void {
  const authorizer = options.authorizer.toLowerCase();
  state.used.add(usedKey(authorizer, options.nonce));
  const common = {
    address: state.mint,
    blockNumber: hexNumber(options.block),
    blockHash: blockHashOf(options.block),
    transactionHash: options.hash,
    removed: false,
  };
  const used = {
    ...common,
    topics: [AUTHORIZATION_USED_TOPIC, topicOf(authorizer), options.nonce],
    data: '0x',
    logIndex: '0x0',
  };
  const transfer = {
    ...common,
    topics: [TRANSFER_TOPIC, topicOf(authorizer), topicOf(options.payee)],
    data: `0x${word(options.value)}`,
    logIndex: '0x1',
  };
  state.logs.push(used, transfer);
  state.receipts.set(options.hash, {
    transactionHash: options.hash,
    status: '0x1',
    blockNumber: hexNumber(options.block),
    blockHash: blockHashOf(options.block),
    logs: [used, transfer],
  });
}

/** An `AuthorizationCanceled(authorizer, nonce)` in `block`. */
export function cancel(state: FakeChain, authorizer: string, nonce: string, block: number): void {
  state.used.add(usedKey(authorizer, nonce));
  state.logs.push({
    address: state.mint,
    topics: [AUTHORIZATION_CANCELED_TOPIC, topicOf(authorizer), nonce],
    data: '0x',
    blockNumber: hexNumber(block),
    blockHash: blockHashOf(block),
    transactionHash: `0x${'c'.repeat(64)}`,
    logIndex: '0x0',
    removed: false,
  });
}

export interface WalletState {
  /** The account the wallet answers. */
  account: string;
  secret: Uint8Array;
  chainId: number;
  /** `eth_chainId` of the wallet fails with this. */
  chainIdError?: unknown;
  requestError?: unknown;
  switchError?: unknown;
  /** The switch answers ok and stays on its chain (P1: Phantom). */
  switchStays?: boolean;
  signError?: unknown;
  /** Sign with another key: the signature does not recover to the payer. */
  signWithOther?: Uint8Array;
  /** Answer the signature with a bare recovery id (v 0/1), as some wallets do. */
  answerBareV?: boolean;
  /** Answer the high-s twin of the signature (still valid for ecrecover, not for FiatToken). */
  answerHighS?: boolean;
  /** More accounts the wallet holds, answered after `account`. */
  extraAccounts?: string[];
  /** The address each typed-data prompt was asked for. */
  signedFor: string[];
  sendError?: unknown;
  /** Runs inside the typed-data prompt, before it answers. */
  onSign?: () => Promise<void>;
  /** Runs inside the send prompt, before it answers. */
  onSend?: () => Promise<void>;
  signed: TransferAuthorizationTypedData[];
  sent: { from: string; to: string; data: string; chainId: string }[];
  /** The hash the next send returns. */
  nextHash: () => string;
}

const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function signHex(
  typed: TransferAuthorizationTypedData,
  secret: Uint8Array,
  form: { bareV: boolean; highS: boolean },
): string {
  const digest = hexToBytes(hashTransferAuthorization(typed).slice(2));
  const signature = bytesToHex(
    secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' }),
  );
  let recovery = Number.parseInt(signature.slice(0, 2), 16);
  const r = signature.slice(2, 66);
  let s = signature.slice(66, 130);
  if (form.highS) {
    s = (CURVE_N - BigInt(`0x${s}`)).toString(16).padStart(64, '0');
    recovery ^= 1;
  }
  const v = form.bareV ? recovery : 27 + recovery;
  return `0x${r}${s}${v.toString(16).padStart(2, '0')}`;
}

export function fakeWallet(
  secret: Uint8Array,
  chainId: number,
): { state: WalletState; wallet: Eip3009Wallet } {
  let sends = 0;
  const state: WalletState = {
    account: addressOf(secret),
    secret,
    chainId,
    signed: [],
    signedFor: [],
    sent: [],
    nextHash: () => {
      sends += 1;
      return `0x${'7'.repeat(56)}${sends.toString(16).padStart(8, '0')}`;
    },
  };
  const wallet: Eip3009Wallet = {
    requestAccounts: async () => {
      if (state.requestError !== undefined) {
        throw state.requestError;
      }
      return [state.account, ...(state.extraAccounts ?? [])];
    },
    switchChain: async (chain) => {
      if (state.switchError !== undefined) {
        throw state.switchError;
      }
      if (state.switchStays !== true) {
        state.chainId = chain.evmChainId ?? 0;
      }
    },
    chainId: async () => {
      if (state.chainIdError !== undefined) {
        throw state.chainIdError;
      }
      return state.chainId;
    },
    signTypedData: async (address, json) => {
      state.signedFor.push(address);
      if (address.toLowerCase() !== state.account.toLowerCase()) {
        throw { code: -32602, message: `this wallet does not sign for ${address}` };
      }
      await state.onSign?.();
      if (state.signError !== undefined) {
        throw state.signError;
      }
      const typed = JSON.parse(json) as TransferAuthorizationTypedData;
      state.signed.push(typed);
      return signHex(typed, state.signWithOther ?? state.secret, {
        bareV: state.answerBareV === true,
        highS: state.answerHighS === true,
      });
    },
    sendTransaction: async (call) => {
      if (call.from.toLowerCase() !== state.account.toLowerCase()) {
        throw { code: -32602, message: `this wallet does not hold ${call.from}` };
      }
      if (Number.parseInt(call.chainId, 16) !== state.chainId) {
        throw { code: -32602, message: 'chainId should be same as current chainId' };
      }
      if (!/^0x[0-9a-f]{40}$/i.test(call.to) || !/^0x(?:[0-9a-f]{2})+$/i.test(call.data)) {
        throw { code: -32602, message: 'malformed transaction' };
      }
      await state.onSend?.();
      if (state.sendError !== undefined) {
        throw state.sendError;
      }
      state.sent.push(call);
      return state.nextHash();
    },
  };
  return { state, wallet };
}

/** The 4-byte selector of an `eth_call`, or `undefined` for any other request. */
export function selectorOf(method: string, params: readonly unknown[]): string | undefined {
  if (method !== 'eth_call') {
    return undefined;
  }
  const request = params[0] as { data?: unknown } | undefined;
  return typeof request?.data === 'string' ? request.data.slice(0, 10) : undefined;
}

/** The block tag of an `eth_getBlockByNumber`, or `undefined` for any other request. */
export function tagOf(method: string, params: readonly unknown[]): unknown {
  return method === 'eth_getBlockByNumber' ? params[0] : undefined;
}
