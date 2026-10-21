/**
 * The `eip3009` rail's builders and readers (`evm/eip3009.ts`), PR 1 of
 * `commerce-evm-chains.md`. Every reader is driven by a scripted client: what
 * it asks for is recorded, and what it answers is exactly what a test says.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { EvmRpcError } from '../src/evm/client';
import { TRANSFER_TOPIC } from '../src/evm/constants';
import {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_USED_TOPIC,
  FIAT_TOKEN_IMPLEMENTATION_SLOT,
  type TransferAuthorizationMessage,
  type TransferAuthorizationTypedData,
  buildTransferAuthorization,
  encodeTransferWithAuthorization,
  estimateTransferWithAuthorization,
  expectedDomainSeparator,
  findAssetTransferNear,
  hashTransferAuthorization,
  listAuthorizationsByNonce,
  listPayoutTransfers,
  normalizeAuthorizationSignature,
  readAuthorizationBinding,
  readAuthorizationCanceled,
  readAuthorizationUsed,
  readBlockAtTag,
  readDomainSeparator,
  readEip3009Legs,
  readEip3009Preflight,
  readFinalizedBlockWithHash,
  readImplementation,
  readL1Fee,
} from '../src/evm/eip3009';
import {
  type Asset,
  PATHUSD_TEMPO,
  USDC_ARBITRUM_DEVNET,
  USDC_ARBITRUM_MAINNET,
  USDC_BASE_DEVNET,
  USDC_BASE_MAINNET,
  USDC_ETHEREUM_DEVNET,
  USDC_ETHEREUM_MAINNET,
} from '../src/payment/assets';
import { CHAINS, type ChainConfig } from '../src/payment/chains';
import LIVE_BASE_RECEIPT from './fixtures/eip3009-base-mainnet.json';

const BASE_SEPOLIA = CHAINS.BASE_DEVNET;
const USDC = USDC_BASE_DEVNET.mint ?? '';
const PAYEE = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const OTHER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const NONCE = `0xfab22e7e${'5a'.repeat(28)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const DELEGATOR = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
/** `Approval(address,address,uint256)`: the same shape as a Transfer, another event. */
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

/** A private key and its address, signed with noble (the reference vector below is viem's). */
const SECRET = hexToBytes('11'.repeat(32));
const PAYER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

function hexBlock(value: number): string {
  return `0x${value.toString(16)}`;
}

type Handler = (params: readonly unknown[]) => unknown;

/** A client answering each method from `handlers`; a method without one throws. */
function scripted(handlers: Record<string, Handler>) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const client = {
    request: async ({ method, params = [] }: { method: string; params?: readonly unknown[] }) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        throw new Error(`unscripted ${method}`);
      }
      return handler(params);
    },
  };
  return { client, calls };
}

function rpcError(code: number, message: string, data?: unknown): EvmRpcError {
  return new EvmRpcError('eth_getLogs', { code, message, ...(data === undefined ? {} : { data }) });
}

function authorization(overrides: Partial<Parameters<typeof buildTransferAuthorization>[0]> = {}) {
  return buildTransferAuthorization({
    chain: BASE_SEPOLIA,
    asset: USDC_BASE_DEVNET,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
    nonce: NONCE,
    validBefore: 1_800_000_000n,
    ...overrides,
  });
}

function sign(typedData: TransferAuthorizationTypedData): {
  r: string;
  s: bigint;
  recovery: number;
} {
  const digest = hexToBytes(hashTransferAuthorization(typedData).slice(2));
  const signature = secp256k1.sign(digest, SECRET, { prehash: false, format: 'recovered' });
  const bytes = bytesToHex(signature);
  return {
    recovery: Number.parseInt(bytes.slice(0, 2), 16),
    r: bytes.slice(2, 66),
    s: BigInt(`0x${bytes.slice(66, 130)}`),
  };
}

const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

describe('the registry domain of each USDC', () => {
  // The on-chain DOMAIN_SEPARATOR() of every chain, read 2026-10-16 (facts file).
  it.each([
    [
      CHAINS.ETHEREUM_MAINNET,
      USDC_ETHEREUM_MAINNET,
      '0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335',
    ],
    [
      CHAINS.ARBITRUM_MAINNET,
      USDC_ARBITRUM_MAINNET,
      '0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78',
    ],
    [
      CHAINS.BASE_MAINNET,
      USDC_BASE_MAINNET,
      '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f',
    ],
    [
      CHAINS.ETHEREUM_DEVNET,
      USDC_ETHEREUM_DEVNET,
      '0xb90e5057db141a932946e64d09ccb7ffc9b00bd79fec26f698d29af0c83320a6',
    ],
    [
      CHAINS.ARBITRUM_DEVNET,
      USDC_ARBITRUM_DEVNET,
      '0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb',
    ],
    [
      CHAINS.BASE_DEVNET,
      USDC_BASE_DEVNET,
      '0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818',
    ],
  ] as [ChainConfig, Asset, string][])(
    'reproduces %s.caip2 on chain',
    (chain, asset, separator) => {
      expect(expectedDomainSeparator(chain, asset)).toBe(separator);
    },
  );
});

describe('buildTransferAuthorization', () => {
  it('builds the typed data a wallet signs, validAfter 0', () => {
    const typedData = authorization();
    expect(typedData.domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 84532,
      verifyingContract: USDC,
    });
    expect(typedData.message).toEqual({
      from: PAYER,
      to: PAYEE,
      value: '1000000',
      validAfter: '0',
      validBefore: '1800000000',
      nonce: NONCE,
    });
    expect(typedData.primaryType).toBe('TransferWithAuthorization');
    // viem's hashTypedData of the same authorization (reference vector).
    expect(hashTransferAuthorization(typedData)).toBe(
      '0xefda684be346684694f08252c86b4432b58b27f03fbca75f6521a099862604f6',
    );
  });

  it('hands the wallet the very types the digest is built from', () => {
    const { types } = authorization();
    expect(types).toEqual({
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    });
    // The wallet hashes `types`; the digest uses fixed typehashes. They must be one thing.
    const typeHashOf = (name: string, fields: readonly { name: string; type: string }[]): string =>
      bytesToHex(
        keccak_256(
          utf8ToBytes(`${name}(${fields.map((field) => `${field.type} ${field.name}`).join(',')})`),
        ),
      );
    expect(typeHashOf('EIP712Domain', types.EIP712Domain)).toBe(
      '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f',
    );
    expect(typeHashOf('TransferWithAuthorization', types.TransferWithAuthorization)).toBe(
      '7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267',
    );
  });

  it("takes the chain id and the domain from the registry, never the caller's objects", () => {
    const typedData = authorization({
      chain: { ...BASE_SEPOLIA, evmChainId: 1 },
      asset: { ...USDC_BASE_DEVNET, eip712: { name: 'USD Coin', version: '1' } },
    });
    expect(typedData.domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 84532,
      verifyingContract: USDC,
    });
    expect(() =>
      authorization({ chain: { ...CHAINS.TEMPO_DEVNET, settlement: 'eip3009' } }),
    ).toThrow(/does not settle over/);
    expect(expectedDomainSeparator({ ...BASE_SEPOLIA, evmChainId: 1 }, USDC_BASE_DEVNET)).toBe(
      expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET),
    );
    expect(
      expectedDomainSeparator(BASE_SEPOLIA, {
        ...USDC_BASE_DEVNET,
        eip712: { name: 'USD Coin', version: '1' },
      }),
    ).toBe(expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET));
  });

  it('throws for each of its four refusals', () => {
    expect(() => authorization({ to: `0x${'0'.repeat(40)}` })).toThrow(/zero address/);
    expect(() => authorization({ to: USDC })).toThrow(/USDC contract/);
    expect(() => authorization({ chain: CHAINS.TEMPO_DEVNET })).toThrow(/does not settle over/);
    expect(() => authorization({ chain: CHAINS.SOLANA_DEVNET })).toThrow(/does not settle over/);
    expect(() => authorization({ asset: { ...USDC_BASE_DEVNET, eip712: undefined } })).toThrow(
      /EIP-712/,
    );
    // And a coin of another chain or environment is no coin of this one.
    expect(() => authorization({ asset: USDC_BASE_MAINNET })).toThrow(/not an EIP-3009 coin/);
    expect(() => authorization({ asset: PATHUSD_TEMPO })).toThrow();
  });

  it('refuses a value or a deadline that is not positive, and a malformed nonce', () => {
    expect(() => authorization({ value: 0n })).toThrow(/positive value/);
    expect(() => authorization({ validBefore: 0n })).toThrow(/validBefore/);
    expect(() => authorization({ value: 1n << 256n })).toThrow(/value does not fit in 256 bits/);
    expect(() => authorization({ validBefore: 1n << 256n })).toThrow(
      /validBefore does not fit in 256 bits/,
    );
    expect(() => authorization({ nonce: '0x1234' })).toThrow(/nonce/);
    expect(() => authorization({ nonce: `0x${'ab'.repeat(31)}` })).toThrow(/nonce/);
    expect(() => authorization({ nonce: `0x${'ab'.repeat(33)}` })).toThrow(/nonce/);
  });
});

describe('normalizeAuthorizationSignature', () => {
  const typedData = authorization();

  it("accepts viem's signature of the reference vector, as is", () => {
    const viem =
      '0xe602c0f6622a611835d8665c5406628a50419ee2a766829ef4f714150d61ab23219b2e9de3c504a33b22e85362897a72c8bbfd6bbef2fb421e8a5eddfd5251d61b';
    expect(normalizeAuthorizationSignature(typedData, viem, PAYER)).toBe(viem);
  });

  it('writes v as 27 or 28, from either 27/28 or a bare 0/1', () => {
    const { r, s, recovery } = sign(typedData);
    const low = word(s);
    const expected = `0x${r}${low}${(27 + recovery).toString(16)}`;
    for (const v of [27 + recovery, recovery]) {
      const signature = `0x${r}${low}${v.toString(16).padStart(2, '0')}`;
      expect(normalizeAuthorizationSignature(typedData, signature, PAYER)).toBe(expected);
    }
    // Upper-case hex and a checksummed payer are the same signature and payer.
    expect(
      normalizeAuthorizationSignature(
        typedData,
        expected.toUpperCase().replace('0X', '0x'),
        PAYER.toUpperCase().replace('0X', '0x'),
      ),
    ).toBe(expected);
  });

  it('folds a high s to its low twin, flipping v: FiatToken reverts on a high s', () => {
    const { r, s, recovery } = sign(typedData);
    const high = N - s;
    const flipped = 1 - recovery;
    const signature = `0x${r}${word(high)}${(27 + flipped).toString(16)}`;
    expect(normalizeAuthorizationSignature(typedData, signature, PAYER)).toBe(
      `0x${r}${word(s)}${(27 + recovery).toString(16)}`,
    );
  });

  it('refuses a signature that does not recover to the payer, or is not one', () => {
    const { r, s, recovery } = sign(typedData);
    const good = `0x${r}${word(s)}${(27 + recovery).toString(16)}`;
    expect(normalizeAuthorizationSignature(typedData, good, OTHER)).toBeUndefined();
    // Another authorization's signature.
    expect(
      normalizeAuthorizationSignature(authorization({ value: 2n }), good, PAYER),
    ).toBeUndefined();
    // The other recovery id recovers someone else.
    const wrongV = `0x${r}${word(s)}${(28 - recovery).toString(16)}`;
    expect(normalizeAuthorizationSignature(typedData, wrongV, PAYER)).toBeUndefined();
    // The payer's own signature of an authorization from someone else: FiatToken
    // checks the signer against `from` and would revert.
    const fromOther = authorization({ from: OTHER });
    const signedByPayer = sign(fromOther);
    expect(
      normalizeAuthorizationSignature(
        fromOther,
        `0x${signedByPayer.r}${word(signedByPayer.s)}${(27 + signedByPayer.recovery).toString(16)}`,
        PAYER,
      ),
    ).toBeUndefined();
    for (const bad of [
      `0x${r}${word(s)}1d`,
      `0x${r}${word(s)}`,
      `${good}00`,
      `0x${'0'.repeat(64)}${word(s)}1b`,
      `0x${r}${'0'.repeat(64)}1b`,
      `0x${r}${word(N)}1b`,
      'not hex',
    ]) {
      expect(normalizeAuthorizationSignature(typedData, bad, PAYER)).toBeUndefined();
    }
  });
});

describe('encodeTransferWithAuthorization', () => {
  const viem =
    '0xe602c0f6622a611835d8665c5406628a50419ee2a766829ef4f714150d61ab23219b2e9de3c504a33b22e85362897a72c8bbfd6bbef2fb421e8a5eddfd5251d61b';

  it("encodes the bytes overload exactly as viem's ABI encoder", () => {
    expect(encodeTransferWithAuthorization(authorization().message, viem)).toBe(
      '0xcf09299500000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000005696da2cecea22f127948458382ac2c59bc8e4bb00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006b49d200fab22e7e5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a00000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000041e602c0f6622a611835d8665c5406628a50419ee2a766829ef4f714150d61ab23219b2e9de3c504a33b22e85362897a72c8bbfd6bbef2fb421e8a5eddfd5251d61b00000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('refuses an ERC-6492-wrapped signature: FiatToken does not unwrap it', () => {
    const wrapped = `0x${'12'.repeat(200)}${'6492'.repeat(16)}`;
    expect(() => encodeTransferWithAuthorization(authorization().message, wrapped)).toThrow(
      /ERC-6492/,
    );
    expect(() =>
      encodeTransferWithAuthorization(authorization().message, `${viem}${'6492'.repeat(16)}`),
    ).toThrow(/ERC-6492/);
  });

  it('refuses anything that is not 65 bytes', () => {
    expect(() => encodeTransferWithAuthorization(authorization().message, `${viem}00`)).toThrow(
      /65 bytes/,
    );
    expect(() => encodeTransferWithAuthorization(authorization().message, 'nope')).toThrow();
  });

  const NOT_DECIMAL = /must be a decimal whole number/;
  const TOO_WIDE = /does not fit in 256 bits/;
  it.each([
    ['value', '-1', NOT_DECIMAL],
    ['value', '1.5', NOT_DECIMAL],
    ['value', '0x10', NOT_DECIMAL],
    ['value', '', NOT_DECIMAL],
    ['value', '01', NOT_DECIMAL],
    ['value', ' 1', NOT_DECIMAL],
    ['value', '+1', NOT_DECIMAL],
    ['value', '1e3', NOT_DECIMAL],
    ['value', '0b1', NOT_DECIMAL],
    ['value', '1\n', NOT_DECIMAL],
    ['validAfter', '0\n', NOT_DECIMAL],
    ['value', (1n << 256n).toString(), TOO_WIDE],
    ['validBefore', '-1', NOT_DECIMAL],
    ['validBefore', 'soon', NOT_DECIMAL],
    ['validBefore', '007', NOT_DECIMAL],
    ['validBefore', (1n << 256n).toString(), TOO_WIDE],
    ['validAfter', '-1', NOT_DECIMAL],
    ['validAfter', '00', NOT_DECIMAL],
    ['validAfter', (1n << 256n).toString(), TOO_WIDE],
  ])('refuses a %s of %s: it would not encode one word', (field, text, reason) => {
    const message = { ...authorization().message, [field]: text };
    expect(() =>
      encodeTransferWithAuthorization(message as TransferAuthorizationMessage, viem),
    ).toThrow(new RegExp(field));
    expect(() =>
      encodeTransferWithAuthorization(message as TransferAuthorizationMessage, viem),
    ).toThrow(reason);
  });

  it('encodes what the builder makes at the widest uint256 it allows', () => {
    const max = (1n << 256n) - 1n;
    const built = authorization({ value: max, validBefore: max });
    const calldata = encodeTransferWithAuthorization(built.message, viem);
    expect(calldata.slice(10 + 128, 10 + 192)).toBe('f'.repeat(64));
    expect(calldata.slice(10 + 256, 10 + 320)).toBe('f'.repeat(64));
  });

  it('encodes the largest uint256 value as one full word', () => {
    const max = ((1n << 256n) - 1n).toString();
    const calldata = encodeTransferWithAuthorization(
      { ...authorization().message, value: max },
      viem,
    );
    expect(calldata.slice(10 + 128, 10 + 192)).toBe('f'.repeat(64));
  });
});

describe('readBlockAtTag', () => {
  it.each(['latest', 'safe', 'finalized'] as const)(
    'reads %s: number, hash and time',
    async (tag) => {
      const { client, calls } = scripted({
        eth_getBlockByNumber: () => ({ number: '0x10', hash: BLOCK_HASH, timestamp: '0x64' }),
      });
      expect(await readBlockAtTag(client, tag)).toEqual({
        number: 16,
        hash: BLOCK_HASH,
        timestamp: 100,
      });
      expect(calls).toEqual([{ method: 'eth_getBlockByNumber', params: [tag, false] }]);
    },
  );

  it('is null for a block without a hash, a failed read, or a throwing provider', async () => {
    expect(
      await readBlockAtTag(
        scripted({ eth_getBlockByNumber: () => ({ number: '0x10', timestamp: '0x1' }) }).client,
        'safe',
      ),
    ).toBeNull();
    for (const block of [
      { timestamp: '0x1', hash: BLOCK_HASH },
      { number: '0x10', hash: BLOCK_HASH },
    ]) {
      expect(
        await readBlockAtTag(scripted({ eth_getBlockByNumber: () => block }).client, 'safe'),
      ).toBeNull();
    }
    expect(await readBlockAtTag(scripted({}).client, 'safe')).toBeNull();
    const sync = {
      request: () => {
        throw new Error('sync');
      },
    };
    expect(await readFinalizedBlockWithHash(sync)).toBeNull();
  });

  it('reads finalized as the end proof F', async () => {
    const { client, calls } = scripted({
      eth_getBlockByNumber: () => ({ number: '0x1', hash: BLOCK_HASH, timestamp: '0x2' }),
    });
    expect(await readFinalizedBlockWithHash(client)).toEqual({
      number: 1,
      hash: BLOCK_HASH,
      timestamp: 2,
    });
    expect(calls[0]?.params[0]).toBe('finalized');
  });
});

describe('readAuthorizationUsed', () => {
  const chainId = () => '0x14a34';
  const answer = (used: boolean) => () => `0x${word(used ? 1n : 0n)}`;

  it('reads authorizationState at latest', async () => {
    const { client, calls } = scripted({ eth_call: answer(true), eth_chainId: chainId });
    expect(
      await readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, NONCE, 'latest'),
    ).toBe('used');
    expect(calls[0]).toEqual({
      method: 'eth_call',
      params: [{ to: USDC, data: `0xe94a0102${word(PAYER)}${NONCE.slice(2)}` }, 'latest'],
    });
  });

  it("re-binds eth_chainId to the registry's chain id, never the caller chain's", async () => {
    const { client } = scripted({ eth_call: answer(false), eth_chainId: chainId });
    expect(
      await readAuthorizationUsed(
        client,
        { ...BASE_SEPOLIA, evmChainId: 1 },
        USDC_BASE_DEVNET,
        PAYER,
        NONCE,
        'latest',
      ),
    ).toBe('unused');
  });

  it('pins the end proof by EIP-1898 block hash, requireCanonical', async () => {
    const { client, calls } = scripted({ eth_call: answer(false), eth_chainId: chainId });
    expect(
      await readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, NONCE, {
        blockHash: BLOCK_HASH,
      }),
    ).toBe('unused');
    expect(calls[0]?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
  });

  it('re-binds eth_chainId before a false answer: another or no chain id is unreadable', async () => {
    const pinned = { blockHash: BLOCK_HASH };
    const read = (chain: Handler | undefined) =>
      readAuthorizationUsed(
        scripted({
          eth_call: answer(false),
          ...(chain === undefined ? {} : { eth_chainId: chain }),
        }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        NONCE,
        pinned,
      );
    expect(await read(chainId)).toBe('unused');
    expect(await read(() => '0xaa36a7')).toBe('unreadable');
    expect(await read(() => 'nonsense')).toBe('unreadable');
    expect(await read(undefined)).toBe('unreadable');
    // The re-read happens AFTER the state read.
    const { client, calls } = scripted({ eth_call: answer(false), eth_chainId: chainId });
    await readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, NONCE, pinned);
    expect(calls.map((call) => call.method)).toEqual(['eth_call', 'eth_chainId']);
  });

  it('is unreadable on an error or an answer that is not a bool, never unused', async () => {
    for (const handlers of [
      {},
      { eth_call: () => '0x' },
      { eth_call: () => `0x${word(2n)}` },
      { eth_call: () => `0x${word(0n)}${word(0n)}` },
    ] as Record<string, Handler>[]) {
      expect(
        await readAuthorizationUsed(
          scripted({ ...handlers, eth_chainId: chainId }).client,
          BASE_SEPOLIA,
          USDC_BASE_DEVNET,
          PAYER,
          NONCE,
          'latest',
        ),
      ).toBe('unreadable');
    }
  });
});

/** A log entry as a node answers it. */
function logEntry(overrides: {
  topics: string[];
  data?: string;
  block?: number;
  logIndex?: number;
  address?: string;
  tx?: string;
  blockHash?: string;
}) {
  return {
    address: overrides.address ?? USDC,
    topics: overrides.topics,
    data: overrides.data ?? '0x',
    blockNumber: hexBlock(overrides.block ?? 100),
    blockHash: overrides.blockHash ?? BLOCK_HASH,
    transactionHash: overrides.tx ?? HASH,
    logIndex: hexBlock(overrides.logIndex ?? 0),
    removed: false,
  };
}

function usedLog(
  authorizer: string,
  nonce: string,
  extra: Partial<Parameters<typeof logEntry>[0]> = {},
) {
  return logEntry({
    topics: [AUTHORIZATION_USED_TOPIC, `0x${word(authorizer)}`, nonce],
    ...extra,
  });
}

function transferLog(
  from: string,
  to: string,
  value: bigint,
  extra: Partial<Parameters<typeof logEntry>[0]> = {},
) {
  return logEntry({
    topics: [TRANSFER_TOPIC, `0x${word(from)}`, `0x${word(to)}`],
    data: `0x${word(value)}`,
    ...extra,
  });
}

/** `eth_getLogs` answering from `logs` by block range, refusing a range wider than `cap`. */
function logsByRange(
  logs: ReturnType<typeof logEntry>[],
  cap: number,
  wording = 'Block range too large for public access: 5000',
) {
  return (params: readonly unknown[]) => {
    const filter = params[0] as { fromBlock: string; toBlock: string };
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    if (to - from + 1 > cap) {
      throw rpcError(-32602, 'invalid params', wording);
    }
    return logs.filter((log) => {
      const block = Number.parseInt(log.blockNumber, 16);
      return block >= from && block <= to;
    });
  };
}

/** Ranges no log walker may read: a negative end, a fraction, NaN, past MAX_SAFE_INTEGER. */
const BAD_RANGES = [
  [-1, 5],
  [1.5, 5],
  [0, 1.5],
  [Number.NaN, 5],
  [0, Number.NaN],
  [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
  [0, Number.MAX_SAFE_INTEGER + 1],
] as const;

describe('readAuthorizationCanceled', () => {
  const cancel = (block: number) =>
    logEntry({
      topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE],
      block,
    });

  it('refuses a malformed range before any request: never not_canceled unlooked', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    for (const [fromBlock, toBlock] of BAD_RANGES) {
      await expect(
        readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, fromBlock, toBlock),
      ).rejects.toThrow(/whole/);
    }
    expect(calls).toHaveLength(0);
  });

  it('finds a cancel at the floor edge, filtered by authorizer and nonce', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([cancel(1000)], 1000) });
    const found = await readAuthorizationCanceled(
      client,
      USDC_BASE_DEVNET,
      PAYER,
      NONCE,
      1000,
      2999,
    );
    expect(found).toEqual({ state: 'canceled', requests: 2 });
    expect(calls[0]?.params[0]).toEqual({
      address: USDC,
      topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE],
      fromBlock: hexBlock(1000),
      toBlock: hexBlock(1999),
    });
    // And at the top edge.
    expect(
      await readAuthorizationCanceled(
        scripted({ eth_getLogs: logsByRange([cancel(2999)], 1000) }).client,
        USDC_BASE_DEVNET,
        PAYER,
        NONCE,
        1000,
        2999,
      ),
    ).toMatchObject({ state: 'canceled' });
  });

  it('is not_canceled only for a COMPLETE walk', async () => {
    expect(
      await readAuthorizationCanceled(
        scripted({ eth_getLogs: logsByRange([], 1000) }).client,
        USDC_BASE_DEVNET,
        PAYER,
        NONCE,
        1000,
        2999,
      ),
    ).toEqual({ state: 'not_canceled', requests: 2 });
    let call = 0;
    const flaky = scripted({
      eth_getLogs: () => {
        call += 1;
        if (call === 2) {
          throw rpcError(-32005, 'rate limit exceeded');
        }
        return [];
      },
    });
    expect(
      await readAuthorizationCanceled(flaky.client, USDC_BASE_DEVNET, PAYER, NONCE, 1000, 2999),
    ).toEqual({ state: 'unreadable', requests: 2 });
  });

  it('halves on a P4 provider wording, from the registry cap down', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([cancel(1400)], 300, 'exceed maximum block range: 300'),
    });
    expect(
      await readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, 1000, 1999),
    ).toMatchObject({ state: 'canceled' });
    const spans = calls.map((entry) => {
      const filter = entry.params[0] as { fromBlock: string; toBlock: string };
      return Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1;
    });
    expect(spans.slice(0, 3)).toEqual([1000, 500, 250]);
  });

  it('refuses a log it did not ask for as unreadable', async () => {
    const strangers = [
      logEntry({ topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(OTHER)}`, NONCE], block: 1000 }),
      // The same authorizer and another nonce: a cancel of another order is no end proof.
      logEntry({
        topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, `0x${'77'.repeat(32)}`],
        block: 1000,
      }),
    ];
    for (const stranger of strangers) {
      expect(
        await readAuthorizationCanceled(
          scripted({ eth_getLogs: () => [stranger] }).client,
          USDC_BASE_DEVNET,
          PAYER,
          NONCE,
          1000,
          1000,
        ),
      ).toMatchObject({ state: 'unreadable' });
    }
  });
});

describe('listPayoutTransfers', () => {
  const pay = (block: number, value = 5n) => transferLog(PAYER, PAYEE, value, { block });

  it('walks the range in chunks of the registry cap, filtering on ONE payout', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([pay(1000), pay(2000), pay(2500)], 1000),
    });
    const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 1000, 2999);
    expect(walk.complete).toBe(true);
    expect(walk.requests).toBe(2);
    // No block skipped between chunks: the second starts right after the first.
    expect(walk.complete ? walk.logs.map((log) => log.blockNumber) : []).toEqual([
      1000, 2000, 2500,
    ]);
    expect(walk.complete ? walk.logs[0] : undefined).toMatchObject({
      from: PAYER,
      to: PAYEE,
      value: 5n,
      txHash: HASH,
      blockHash: BLOCK_HASH,
      logIndex: 0,
    });
    expect((calls[0]?.params[0] as { topics: unknown } | undefined)?.topics).toEqual([
      TRANSFER_TOPIC,
      null,
      `0x${word(PAYEE)}`,
    ]);
  });

  it("defaults the chunk to the coin's own registry cap on each chain", async () => {
    for (const [asset, cap] of [
      [USDC_ETHEREUM_MAINNET, 100],
      [USDC_ARBITRUM_MAINNET, 5000],
    ] as const) {
      const { client, calls } = scripted({ eth_getLogs: logsByRange([], cap) });
      const walk = await listPayoutTransfers(client, asset, PAYEE, 1000, 20999);
      expect(walk).toMatchObject({ complete: true });
      const first = calls[0]?.params[0] as { fromBlock: string; toBlock: string } | undefined;
      expect(
        Number.parseInt(first?.toBlock ?? '0x0', 16) -
          Number.parseInt(first?.fromBlock ?? '0x0', 16) +
          1,
      ).toBe(cap);
    }
  });

  it('keeps a log whose address is checksummed (mixed case)', async () => {
    const { client } = scripted({
      eth_getLogs: logsByRange(
        [
          transferLog(PAYER, PAYEE, 5n, {
            block: 1000,
            address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          }),
        ],
        1000,
      ),
    });
    const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 1000, 1999);
    expect(walk).toMatchObject({ complete: true });
    expect(walk.complete ? walk.logs.length : 0).toBe(1);
  });

  it('refuses a negative fromBlock before any request', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    await expect(listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, -1, 5)).rejects.toThrow(
      /non-negative/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses either end of the range that is not a whole number', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    for (const [fromBlock, toBlock] of [
      [1.5, 5],
      [0, 1.5],
      [0, Number.NaN],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await expect(
        listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, fromBlock, toBlock),
      ).rejects.toThrow(/whole/);
    }
    expect(calls).toHaveLength(0);
  });

  it('stops incomplete after MAX_LOG_SCAN_REQUESTS requests, never one more', async () => {
    const { client, calls } = scripted({ eth_getLogs: () => [] });
    expect(
      await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 999, { rangeCap: 1 }),
    ).toEqual({ complete: false, requests: 512 });
    expect(calls).toHaveLength(512);
  });

  it('refuses a rangeCap below 1 or not whole before any request', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    for (const rangeCap of [0, 1.5]) {
      await expect(
        listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 5, { rangeCap }),
      ).rejects.toThrow(/at least 1/);
    }
    expect(calls).toHaveLength(0);
  });

  it('stops incomplete when the node calls one block too much: no halving below 1', async () => {
    const { client } = scripted({
      eth_getLogs: () => {
        throw rpcError(-32614, 'eth_getLogs is limited to a 0 range');
      },
    });
    expect(
      await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 5, { rangeCap: 1 }),
    ).toEqual({ complete: false, requests: 1 });
  });

  it('honours a rangeCap override and counts every request, halvings included', async () => {
    const { client } = scripted({
      eth_getLogs: logsByRange([], 100, 'eth_getLogs is limited to a 100 range'),
    });
    const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 399, {
      rangeCap: 200,
    });
    // 200 (refused), 100, 100, 100, 100.
    expect(walk).toEqual({ complete: true, logs: [], requests: 5 });
    const exact = await listPayoutTransfers(
      scripted({ eth_getLogs: logsByRange([], 100) }).client,
      USDC_BASE_DEVNET,
      PAYEE,
      0,
      399,
      { rangeCap: 100 },
    );
    expect(exact.requests).toBe(4);
  });

  it('honours the rangeCap override on the cancel and nonce walkers too', async () => {
    const refusingAbove100 = () =>
      scripted({ eth_getLogs: logsByRange([], 100, 'eth_getLogs is limited to a 100 range') })
        .client;
    // 200 (refused), 100, 100, 100, 100.
    expect(
      await readAuthorizationCanceled(refusingAbove100(), USDC_BASE_DEVNET, PAYER, NONCE, 0, 399, {
        rangeCap: 200,
      }),
    ).toEqual({ state: 'not_canceled', requests: 5 });
    expect(
      await readAuthorizationCanceled(refusingAbove100(), USDC_BASE_DEVNET, PAYER, NONCE, 0, 399, {
        rangeCap: 100,
      }),
    ).toEqual({ state: 'not_canceled', requests: 4 });
    expect(
      await listAuthorizationsByNonce(refusingAbove100(), USDC_BASE_DEVNET, NONCE, 0, 399, {
        rangeCap: 200,
      }),
    ).toEqual({ complete: true, logs: [], requests: 5 });
    expect(
      await listAuthorizationsByNonce(refusingAbove100(), USDC_BASE_DEVNET, NONCE, 0, 399, {
        rangeCap: 100,
      }),
    ).toEqual({ complete: true, logs: [], requests: 4 });
  });

  it('makes no request on the cancel and nonce walkers once the signal is aborted', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    expect(
      await readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, 0, 399, {
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ state: 'unreadable', requests: 0 });
    expect(
      await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 0, 399, {
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ complete: false, requests: 0 });
    expect(calls).toHaveLength(0);
  });

  it('is incomplete with no request for a reversed range: never "looked, nothing"', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    expect(await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 2000, 1999)).toEqual({
      complete: false,
      requests: 0,
    });
    expect(await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 2000, 1000)).toEqual({
      complete: false,
      requests: 0,
    });
    expect(
      await readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, 2000, 1000),
    ).toEqual({ state: 'unreadable', requests: 0 });
    expect(calls).toHaveLength(0);
  });

  it('reads a range of one block: fromBlock equal to toBlock', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    expect(await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 2000, 2000)).toEqual({
      complete: true,
      logs: [],
      requests: 1,
    });
    expect(await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 2000, 2000)).toEqual({
      complete: true,
      logs: [],
      requests: 1,
    });
    expect(
      await readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, 2000, 2000),
    ).toEqual({ state: 'not_canceled', requests: 1 });
    expect(calls.map((call) => call.params[0])).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ fromBlock: hexBlock(2000), toBlock: hexBlock(2000) }),
      ),
    );
  });

  it('is complete or incomplete, never a silent partial list', async () => {
    let call = 0;
    const { client } = scripted({
      eth_getLogs: (params) => {
        call += 1;
        if (call === 2) {
          throw rpcError(-32000, 'header not found');
        }
        return logsByRange([pay(1000), pay(2500)], 1000)(params);
      },
    });
    const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 1000, 2999);
    expect(walk).toEqual({ complete: false, requests: 2 });
    expect('logs' in walk).toBe(false);
    const whole = pay(1000);
    const without = (key: keyof typeof whole) =>
      Object.fromEntries(Object.entries(whole).filter(([field]) => field !== key));
    for (const answer of [
      ...(
        [
          'address',
          'topics',
          'data',
          'transactionHash',
          'logIndex',
          'blockNumber',
          'blockHash',
        ] as const
      ).map((key) => () => [without(key)]),
      // An ERC-721 style Transfer: a fourth topic.
      () => [{ ...whole, topics: [...whole.topics, `0x${word(1n)}`] }],
      // A sender topic with dirty high bytes is no address.
      () => [{ ...whole, topics: [TRANSFER_TOPIC, `0x${'ff'.repeat(32)}`, `0x${word(PAYEE)}`] }],
      // Below the asked chunk.
      () => [pay(999)],
      () => 'not a list',
      () => [{ ...pay(1000), topics: [TRANSFER_TOPIC] }],
      () => [transferLog(PAYER, OTHER, 5n, { block: 1000 })],
      () => [pay(5000)],
      () => [{ ...pay(1000), address: OTHER }],
    ]) {
      expect(
        (
          await listPayoutTransfers(
            scripted({ eth_getLogs: answer }).client,
            USDC_BASE_DEVNET,
            PAYEE,
            1000,
            1999,
          )
        ).complete,
      ).toBe(false);
    }
  });

  it('makes no request once the signal is aborted, and is incomplete', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([pay(1000)], 1000) });
    const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 1000, 1999, {
      signal: AbortSignal.abort(),
    });
    expect(walk).toEqual({ complete: false, requests: 0 });
    expect(calls).toHaveLength(0);
  });

  it('is incomplete when the node answers an Approval to the payout as a transfer', async () => {
    const approval = logEntry({
      topics: [APPROVAL_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYEE)}`],
      data: `0x${word(5n)}`,
      block: 1000,
    });
    expect(
      await listPayoutTransfers(
        scripted({ eth_getLogs: () => [approval] }).client,
        USDC_BASE_DEVNET,
        PAYEE,
        1000,
        1000,
      ),
    ).toEqual({ complete: false, requests: 1 });
  });

  it('lists a zero-value transfer: dropping it is the caller rule', async () => {
    const walk = await listPayoutTransfers(
      scripted({ eth_getLogs: () => [pay(1000, 0n)] }).client,
      USDC_BASE_DEVNET,
      PAYEE,
      1000,
      1000,
    );
    expect(walk.complete ? walk.logs[0]?.value : undefined).toBe(0n);
  });
});

describe('listAuthorizationsByNonce', () => {
  it('refuses a malformed range before any request: never an empty list unlooked', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1000) });
    for (const [fromBlock, toBlock] of BAD_RANGES) {
      await expect(
        listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, fromBlock, toBlock),
      ).rejects.toThrow(/whole/);
    }
    expect(calls).toHaveLength(0);
  });

  it('returns every use of the nonce in a busy chunk, in order', async () => {
    const { client } = scripted({
      eth_getLogs: logsByRange(
        [
          usedLog(PAYER, NONCE, { block: 1500, logIndex: 3 }),
          usedLog(OTHER, NONCE, { block: 1500, logIndex: 7 }),
          usedLog(PAYER, NONCE, { block: 1600, logIndex: 1 }),
        ],
        1000,
      ),
    });
    const walk = await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 1000, 1999);
    expect(
      walk.complete ? walk.logs.map((log) => [log.blockNumber, log.logIndex, log.authorizer]) : [],
    ).toEqual([
      [1500, 3, PAYER],
      [1500, 7, OTHER],
      [1600, 1, PAYER],
    ]);
  });

  it('is incomplete for a log with a dirty authorizer topic or a fourth topic', async () => {
    const whole = usedLog(PAYER, NONCE, { block: 1000 });
    for (const answer of [
      { ...whole, topics: [AUTHORIZATION_USED_TOPIC, `0x${'ff'.repeat(32)}`, NONCE] },
      { ...whole, topics: [...whole.topics, NONCE] },
    ]) {
      expect(
        await listAuthorizationsByNonce(
          scripted({ eth_getLogs: () => [answer] }).client,
          USDC_BASE_DEVNET,
          NONCE,
          1000,
          1000,
        ),
      ).toEqual({ complete: false, requests: 1 });
    }
  });

  it('takes the nonce in any hex case', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([usedLog(PAYER, NONCE, { block: 1500, logIndex: 3 })], 1000),
    });
    const upper = `0x${NONCE.slice(2).toUpperCase()}`;
    const walk = await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, upper, 1000, 1999);
    expect(walk).toMatchObject({ complete: true, requests: 1 });
    expect((calls[0]?.params[0] as { topics: unknown[] } | undefined)?.topics[2]).toBe(NONCE);
  });

  it('filters AuthorizationUsed on topics[2] = the nonce, complete or not', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([usedLog(PAYER, NONCE, { block: 1500, logIndex: 3 })], 1000),
    });
    const walk = await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 1000, 2999);
    expect(walk).toEqual({
      complete: true,
      requests: 2,
      logs: [
        {
          txHash: HASH,
          blockNumber: 1500,
          blockHash: BLOCK_HASH,
          logIndex: 3,
          authorizer: PAYER,
          nonce: NONCE,
        },
      ],
    });
    expect((calls[0]?.params[0] as { topics: unknown } | undefined)?.topics).toEqual([
      AUTHORIZATION_USED_TOPIC,
      null,
      NONCE,
    ]);
    let call = 0;
    const failing = scripted({
      eth_getLogs: (params) => {
        call += 1;
        if (call === 2) {
          throw new Error('fetch failed');
        }
        return logsByRange([usedLog(PAYER, NONCE, { block: 1500 })], 1000)(params);
      },
    });
    expect(
      await listAuthorizationsByNonce(failing.client, USDC_BASE_DEVNET, NONCE, 1000, 2999),
    ).toEqual({ complete: false, requests: 2 });
    // Another nonce in the answer is not what was asked for.
    expect(
      (
        await listAuthorizationsByNonce(
          scripted({ eth_getLogs: () => [usedLog(PAYER, `0x${'11'.repeat(32)}`, { block: 1000 })] })
            .client,
          USDC_BASE_DEVNET,
          NONCE,
          1000,
          1000,
        )
      ).complete,
    ).toBe(false);
  });
});

describe('the log readers and the P4 wordings', () => {
  // The "ask for less" answers of the qualified providers, each as it arrives.
  it.each([
    [
      'Tenderly, in data as a string',
      rpcError(-32602, 'invalid params', 'Block range too large for public access: 5000'),
    ],
    ['publicnode', rpcError(-32701, 'exceed maximum block range: 50000')],
    ['sepolia.base.org', rpcError(-32614, 'eth_getLogs is limited to a 200 range')],
    ['1rpc', rpcError(-32602, 'eth_getLogs is limited to 0 - 50 blocks range')],
    ['drpc', rpcError(35, 'ranges over 10000 blocks are not supported on free plan')],
    [
      'Alchemy PAYG (unverified live)',
      rpcError(
        -32602,
        'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
      ),
    ],
    ['Infura (unverified live)', rpcError(-32005, 'query returned more than 10000 results')],
    [
      'a wallet error shape',
      {
        code: -32602,
        message: 'invalid params',
        data: { message: 'exceed maximum block range: 50' },
      },
    ],
  ])('halves on %s', async (_label, error) => {
    let first = true;
    const { client } = scripted({
      eth_getLogs: () => {
        if (first) {
          first = false;
          throw error;
        }
        return [];
      },
    });
    expect(await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 999)).toEqual({
      complete: true,
      logs: [],
      requests: 3,
    });
    first = true;
    expect(await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 0, 999)).toEqual({
      complete: true,
      logs: [],
      requests: 3,
    });
  });

  it.each([
    ['invalid block range params', rpcError(-32000, 'invalid block range params')],
    ['a range past the head', rpcError(-32602, 'block range extends beyond current head block')],
    ['a rate limit', rpcError(-32005, 'rate limit exceeded')],
    ['an archive refusal', rpcError(-32602, 'Archive requests require a personal token.')],
  ])('does not halve on %s: incomplete at once', async (_label, error) => {
    const { client } = scripted({
      eth_getLogs: () => {
        throw error;
      },
    });
    expect(await listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 0, 999)).toEqual({
      complete: false,
      requests: 1,
    });
    expect(await listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 0, 999)).toEqual({
      complete: false,
      requests: 1,
    });
  });
});

describe('findAssetTransferNear', () => {
  it('walks forward in chunks doubling from one block, and answers the first transfer', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([transferLog(PAYER, OTHER, 9n, { block: 1005 })], 100000),
    });
    const found = await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 1000);
    expect(found).toMatchObject({ state: 'found', log: { blockNumber: 1005, value: 9n } });
    const ranges = calls.map((entry) => {
      const filter = entry.params[0] as { fromBlock: string; toBlock: string; topics: unknown };
      expect(filter.topics).toEqual([TRANSFER_TOPIC]);
      return [Number.parseInt(filter.fromBlock, 16), Number.parseInt(filter.toBlock, 16)];
    });
    expect(ranges).toEqual([
      [1000, 1000],
      [1001, 1002],
      [1003, 1006],
    ]);
  });

  it('answers the first transfer of a busy chunk, as on mainnet', async () => {
    const { client } = scripted({
      eth_getLogs: logsByRange(
        [
          transferLog(PAYER, OTHER, 9n, { block: 1005, logIndex: 2 }),
          transferLog(OTHER, PAYEE, 4n, { block: 1005, logIndex: 6 }),
          transferLog(PAYEE, PAYER, 1n, { block: 1006, logIndex: 0 }),
        ],
        100000,
      ),
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 1000)).toMatchObject({
      state: 'found',
      log: { blockNumber: 1005, logIndex: 2, from: PAYER, to: OTHER, value: 9n },
    });
  });

  it('halves on a too-much answer and is none only once the whole cap answered empty', async () => {
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 3) });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 10)).toMatchObject({
      state: 'none',
    });
    const ranges = calls.map((entry) => {
      const filter = entry.params[0] as { fromBlock: string; toBlock: string };
      return [Number.parseInt(filter.fromBlock, 16), Number.parseInt(filter.toBlock, 16)];
    });
    // 1, 2, 4 (too much) -> 2, ... never past the cap, never a block skipped.
    expect(ranges[0]).toEqual([1000, 1000]);
    expect(ranges[2]).toEqual([1003, 1006]);
    expect(ranges[3]).toEqual([1003, 1004]);
    expect(ranges.at(-1)?.[1]).toBe(1009);
    const served = ranges.filter(([from, to]) => (to ?? 0) - (from ?? 0) + 1 <= 3);
    const covered = new Set(
      served.flatMap(([from, to]) =>
        Array.from({ length: (to ?? 0) - (from ?? 0) + 1 }, (_, index) => (from ?? 0) + index),
      ),
    );
    expect(covered.size).toBe(10);
  });

  it('never reads past the cap', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([transferLog(PAYER, OTHER, 9n, { block: 1010 })], 100000),
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 10)).toMatchObject({
      state: 'none',
    });
    const last = calls.at(-1)?.params[0] as { toBlock: string };
    expect(Number.parseInt(last.toBlock, 16)).toBe(1009);
  });

  it('reads the last block of the cap when the doubling walk ends on it', async () => {
    // Cap 8: chunks [1000], [1001-1002], [1003-1006], [1007].
    const { client } = scripted({
      eth_getLogs: logsByRange([transferLog(PAYER, OTHER, 9n, { block: 1007 })], 100000),
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 8)).toMatchObject({
      state: 'found',
      log: { blockNumber: 1007 },
      requests: 4,
    });
  });

  it('is unreadable when the provider answers a log outside the asked chunk', async () => {
    const { client } = scripted({
      eth_getLogs: () => [transferLog(PAYER, OTHER, 9n, { block: 5000 })],
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 1000)).toMatchObject({
      state: 'unreadable',
      requests: 1,
    });
  });

  it('is unreadable when the provider answers a Transfer of another contract', async () => {
    const { client } = scripted({
      eth_getLogs: () => [transferLog(PAYER, OTHER, 9n, { block: 1000, address: OTHER })],
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 1000)).toMatchObject({
      state: 'unreadable',
      requests: 1,
    });
  });

  it('is unreadable when the provider answers an Approval as a transfer', async () => {
    const approval = logEntry({
      topics: [APPROVAL_TOPIC, `0x${word(PAYER)}`, `0x${word(OTHER)}`],
      data: `0x${word(9n)}`,
      block: 1000,
    });
    expect(
      await findAssetTransferNear(
        scripted({ eth_getLogs: () => [approval] }).client,
        USDC_BASE_DEVNET,
        1000,
        1000,
      ),
    ).toMatchObject({ state: 'unreadable', requests: 1 });
  });

  it('is unreadable on any other error', async () => {
    expect(
      await findAssetTransferNear(
        scripted({
          eth_getLogs: () => {
            throw rpcError(-32005, 'rate limit exceeded');
          },
        }).client,
        USDC_BASE_DEVNET,
        1000,
        1000,
      ),
    ).toMatchObject({ state: 'unreadable', requests: 1 });
  });

  it('refuses a cap below 1 before any request', async () => {
    const { client, calls } = scripted({ eth_getLogs: () => [] });
    await expect(findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 0)).rejects.toThrow(
      /at least 1/,
    );
    expect(calls).toHaveLength(0);
  });

  it('reads one block for a cap of 1', async () => {
    const { client, calls } = scripted({
      eth_getLogs: logsByRange([transferLog(PAYER, OTHER, 9n, { block: 1000 })], 100000),
    });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 1000, 1)).toMatchObject({
      state: 'found',
      requests: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it('is unreadable when one block is too much, and on another error after a doubling', async () => {
    const tooMuch = scripted({
      eth_getLogs: () => {
        throw rpcError(-32614, 'eth_getLogs is limited to a 0 range');
      },
    });
    expect(await findAssetTransferNear(tooMuch.client, USDC_BASE_DEVNET, 1000, 1000)).toEqual({
      state: 'unreadable',
      requests: 1,
    });
    let call = 0;
    const flaky = scripted({
      eth_getLogs: () => {
        call += 1;
        if (call === 3) {
          throw rpcError(-32005, 'rate limit exceeded');
        }
        return [];
      },
    });
    // Spans 1, 2, then 4 fails for a reason that is not too much: no halving.
    expect(await findAssetTransferNear(flaky.client, USDC_BASE_DEVNET, 1000, 1000)).toEqual({
      state: 'unreadable',
      requests: 3,
    });
  });

  it('stops unreadable after MAX_LOG_SCAN_REQUESTS requests, never one more', async () => {
    // Every span above one block is too much: two requests per block.
    const { client, calls } = scripted({ eth_getLogs: logsByRange([], 1) });
    expect(await findAssetTransferNear(client, USDC_BASE_DEVNET, 0, 100000)).toEqual({
      state: 'unreadable',
      requests: 512,
    });
    expect(calls).toHaveLength(512);
  });

  it('is unreadable for a Transfer whose payee topic is no address', async () => {
    const dirty = logEntry({
      topics: [TRANSFER_TOPIC, `0x${word(PAYER)}`, `0x${'ff'.repeat(32)}`],
      data: `0x${word(9n)}`,
      block: 1000,
    });
    expect(
      await findAssetTransferNear(
        scripted({ eth_getLogs: () => [dirty] }).client,
        USDC_BASE_DEVNET,
        1000,
        10,
      ),
    ).toMatchObject({ state: 'unreadable' });
  });

  it('refuses a fromBlock that is not a whole, non-negative number: never none unlooked', async () => {
    const { client, calls } = scripted({ eth_getLogs: () => [] });
    for (const fromBlock of [Number.NaN, -1, 1.5]) {
      await expect(findAssetTransferNear(client, USDC_BASE_DEVNET, fromBlock, 10)).rejects.toThrow(
        /block range/,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

/** A node holding `receipt` and the blocks its trust rules read. */
function receiptNode(options: {
  receipt: unknown;
  creditBlock?: number;
  ownBlockHash?: string;
  /** `null`: the `eth_chainId` read fails. */
  chainId?: string | null;
}) {
  return scripted({
    eth_getTransactionReceipt: () => options.receipt,
    eth_getBlockByNumber: (params) => {
      if (params[0] === 'safe' || params[0] === 'finalized' || params[0] === 'latest') {
        const number = options.creditBlock ?? 1_000_000_000;
        return { number: hexBlock(number), hash: `0x${'ee'.repeat(32)}`, timestamp: '0x1' };
      }
      return {
        number: params[0],
        hash: options.ownBlockHash ?? readField(options.receipt, 'blockHash'),
        timestamp: '0x1',
      };
    },
    eth_chainId: () => {
      if (options.chainId === null) {
        throw new Error('chain id unavailable');
      }
      return options.chainId ?? '0x14a34';
    },
  });
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function receiptOf(logs: ReturnType<typeof logEntry>[], overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: HASH,
    status: '0x1',
    blockNumber: hexBlock(100),
    blockHash: BLOCK_HASH,
    logs,
    ...overrides,
  };
}

const LEG_OPTIONS = {
  chain: BASE_SEPOLIA,
  asset: USDC_BASE_DEVNET,
  nonce: NONCE,
  to: PAYEE,
  minValue: 1_000_000n,
};

describe('readEip3009Legs', () => {
  const pair = [
    usedLog(PAYER, NONCE, { logIndex: 4 }),
    transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
  ];

  it('matches the live Base receipt: AuthorizationUsed, then the Transfer at index + 1', async () => {
    const live = LIVE_BASE_RECEIPT;
    const node = scripted({
      eth_getTransactionReceipt: () => live,
      eth_getBlockByNumber: (params) =>
        params[0] === 'safe'
          ? { number: hexBlock(52_700_000), hash: `0x${'ee'.repeat(32)}`, timestamp: '0x1' }
          : { number: params[0], hash: live.blockHash, timestamp: '0x1' },
      eth_chainId: () => '0x2105',
    });
    const legs = await readEip3009Legs(node.client, live.transactionHash, {
      chain: CHAINS.BASE_MAINNET,
      asset: USDC_BASE_MAINNET,
      nonce: '0x6120159a8f93ba00096bf6d5922de5587ad7a5364d825e3592a47dc17e9a4269',
      to: '0x7284d41b5b852f2bd4c99bdf95043d84452d299c',
      minValue: 20_000n,
    });
    expect(legs).toEqual({
      state: 'paid',
      leg: {
        txHash: live.transactionHash,
        blockNumber: 0x323f6b8,
        blockHash: live.blockHash,
        logIndex: 0x72,
        authorizer: '0x82207aac77316911396d0c965dc05d105979c686',
        value: 20_000n,
      },
    });
  });

  it("reads the registry's credit tag, never the caller chain's", async () => {
    const { client, calls } = receiptNode({ receipt: receiptOf(pair), creditBlock: 100 });
    const paid = await readEip3009Legs(client, HASH, {
      ...LEG_OPTIONS,
      chain: { ...BASE_SEPOLIA, evmChainId: 1, finality: { credit: 'finalized' } },
    });
    expect(paid.state).toBe('paid');
    expect(
      calls.some((call) => call.method === 'eth_getBlockByNumber' && call.params[0] === 'safe'),
    ).toBe(true);
    expect(calls.some((call) => call.params[0] === 'finalized')).toBe(false);
  });

  it('reads a log whose address is checksummed (mixed case)', async () => {
    const checksummed = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const mixed = [
      usedLog(PAYER, NONCE, { logIndex: 4, address: checksummed }),
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5, address: checksummed }),
    ];
    const read = await readEip3009Legs(
      receiptNode({ receipt: receiptOf(mixed), creditBlock: 100 }).client,
      HASH,
      LEG_OPTIONS,
    );
    expect(read.state).toBe('paid');
  });

  it('is paid at or below the credit tag and pending above it, both carrying the block', async () => {
    const paid = await readEip3009Legs(
      receiptNode({ receipt: receiptOf(pair), creditBlock: 100 }).client,
      HASH,
      LEG_OPTIONS,
    );
    expect(paid).toEqual({
      state: 'paid',
      leg: {
        txHash: HASH,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        logIndex: 5,
        authorizer: PAYER,
        value: 1_000_000n,
      },
    });
    const pending = await readEip3009Legs(
      receiptNode({ receipt: receiptOf(pair), creditBlock: 99 }).client,
      HASH,
      LEG_OPTIONS,
    );
    expect(pending).toMatchObject({
      state: 'pending',
      leg: { blockNumber: 100, blockHash: BLOCK_HASH },
    });
    // The credit tag is the registry's (`safe`).
    const node = receiptNode({ receipt: receiptOf(pair), creditBlock: 100 });
    await readEip3009Legs(node.client, HASH, LEG_OPTIONS);
    expect(
      node.calls.some(
        (call) => call.method === 'eth_getBlockByNumber' && call.params[0] === 'safe',
      ),
    ).toBe(true);
  });

  it('credits only the ADJACENT pair: same proxy, same authorizer, the payee, at least the value', async () => {
    const crafted: [string, ReturnType<typeof logEntry>[]][] = [
      [
        'a Transfer two logs later',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          transferLog(PAYER, OTHER, 1n, { logIndex: 5 }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 6 }),
        ],
      ],
      [
        'another USDC log between the authorization and its Transfer',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          logEntry({
            topics: [APPROVAL_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYEE)}`],
            data: `0x${word(1_000_000n)}`,
            logIndex: 5,
          }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 6 }),
        ],
      ],
      [
        'a Transfer BEFORE the authorization',
        [
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 3 }),
          usedLog(PAYER, NONCE, { logIndex: 4 }),
        ],
      ],
      [
        'another authorizer',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          transferLog(OTHER, PAYEE, 1_000_000n, { logIndex: 5 }),
        ],
      ],
      [
        'another payee',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          transferLog(PAYER, OTHER, 1_000_000n, { logIndex: 5 }),
        ],
      ],
      [
        'less than the price',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          transferLog(PAYER, PAYEE, 999_999n, { logIndex: 5 }),
        ],
      ],
      [
        'another nonce',
        [
          usedLog(PAYER, `0x${'11'.repeat(32)}`, { logIndex: 4 }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
        ],
      ],
      [
        'another emitter for the Transfer',
        [
          usedLog(PAYER, NONCE, { logIndex: 4 }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5, address: OTHER }),
        ],
      ],
      [
        'another emitter for the authorization',
        [
          usedLog(PAYER, NONCE, { logIndex: 4, address: OTHER }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
        ],
      ],
      [
        'an AuthorizationUsed carrying data',
        [
          usedLog(PAYER, NONCE, { logIndex: 4, data: `0x${word(1n)}` }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
        ],
      ],
      [
        'a cancel instead of a use',
        [
          logEntry({
            topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE],
            logIndex: 4,
          }),
          transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
        ],
      ],
    ];
    for (const [label, logs] of crafted) {
      const legs = await readEip3009Legs(
        receiptNode({ receipt: receiptOf(logs) }).client,
        HASH,
        LEG_OPTIONS,
      );
      expect(legs, label).toEqual({
        state: 'none',
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        final: true,
      });
    }
    // More than the price is a leg.
    const more = [
      usedLog(PAYER, NONCE, { logIndex: 4 }),
      transferLog(PAYER, PAYEE, 2_000_000n, { logIndex: 5 }),
    ];
    expect(
      await readEip3009Legs(receiptNode({ receipt: receiptOf(more) }).client, HASH, LEG_OPTIONS),
    ).toMatchObject({ state: 'paid' });
    // A batch carrying the nonce twice: a failed first pair does not hide the paying one.
    const batch = [
      usedLog(OTHER, NONCE, { logIndex: 2 }),
      transferLog(OTHER, OTHER, 1_000_000n, { logIndex: 3 }),
      usedLog(PAYER, NONCE, { logIndex: 4 }),
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
    ];
    expect(
      await readEip3009Legs(
        receiptNode({ receipt: receiptOf(batch), creditBlock: 100 }).client,
        HASH,
        LEG_OPTIONS,
      ),
    ).toMatchObject({ state: 'paid', leg: { authorizer: PAYER, logIndex: 5 } });
  });

  it('answers absent, none and unreadable by the trust rules', async () => {
    expect(await readEip3009Legs(receiptNode({ receipt: null }).client, HASH, LEG_OPTIONS)).toEqual(
      { state: 'absent' },
    );
    // Reverted: none, once the chain is named.
    expect(
      await readEip3009Legs(
        receiptNode({ receipt: receiptOf(pair, { status: '0x0' }) }).client,
        HASH,
        LEG_OPTIONS,
      ),
    ).toEqual({ state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: true });
    for (const [label, node] of [
      [
        'another tx hash',
        receiptNode({ receipt: receiptOf(pair, { transactionHash: `0x${'99'.repeat(32)}` }) }),
      ],
      [
        'a block this node does not hold',
        receiptNode({ receipt: receiptOf(pair), ownBlockHash: `0x${'77'.repeat(32)}` }),
      ],
      [
        'a log of another block',
        receiptNode({
          receipt: receiptOf([
            pair[0],
            transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5, block: 101 }),
          ] as ReturnType<typeof logEntry>[]),
        }),
      ],
      [
        'a log of another transaction',
        receiptNode({
          receipt: receiptOf([
            pair[0],
            transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5, tx: `0x${'99'.repeat(32)}` }),
          ]),
        }),
      ],
      [
        'a log of another block at the same height',
        receiptNode({
          receipt: receiptOf([
            pair[0],
            transferLog(PAYER, PAYEE, 1_000_000n, {
              logIndex: 5,
              blockHash: `0x${'77'.repeat(32)}`,
            }),
          ]),
        }),
      ],
      [
        'a pending leg in a block this node does not hold',
        receiptNode({
          receipt: receiptOf(pair),
          creditBlock: 99,
          ownBlockHash: `0x${'77'.repeat(32)}`,
        }),
      ],
      [
        'another chain id before paid',
        receiptNode({ receipt: receiptOf(pair), chainId: '0xaa36a7' }),
      ],
      ['a status that is not 0 or 1', receiptNode({ receipt: receiptOf(pair, { status: '0x2' }) })],
      [
        'a receipt without a block number',
        receiptNode({ receipt: { ...receiptOf([]), blockNumber: undefined } }),
      ],
      [
        'a receipt without a block hash',
        receiptNode({ receipt: { ...receiptOf([]), blockHash: undefined } }),
      ],
      ['a receipt without logs', receiptNode({ receipt: { ...receiptOf([]), logs: undefined } })],
      [
        'a log without an emitter',
        receiptNode({ receipt: receiptOf([pair[0], { ...pair[1], address: undefined }]) }),
      ],
      [
        'a log without data',
        receiptNode({ receipt: receiptOf([pair[0], { ...pair[1], data: undefined }]) }),
      ],
      [
        'a removed log',
        receiptNode({ receipt: receiptOf([pair[0], { ...pair[1], removed: true }]) }),
      ],
    ] as const) {
      expect(await readEip3009Legs(node.client, HASH, LEG_OPTIONS), label).toEqual({
        state: 'unreadable',
      });
    }
    // Another chain id before a "none" too.
    expect(
      await readEip3009Legs(
        receiptNode({ receipt: receiptOf([]), chainId: '0xaa36a7' }).client,
        HASH,
        LEG_OPTIONS,
      ),
    ).toEqual({ state: 'unreadable' });
    expect(await readEip3009Legs(scripted({}).client, HASH, LEG_OPTIONS)).toEqual({
      state: 'unreadable',
    });
  });

  it('answers none as final only at or below the credit tag, reverted or leg-less', async () => {
    for (const [label, receipt] of [
      ['reverted', receiptOf(pair, { status: '0x0' })],
      ['leg-less', receiptOf([transferLog(PAYER, OTHER, 1n, { logIndex: 5 })])],
    ] as const) {
      expect(
        await readEip3009Legs(receiptNode({ receipt, creditBlock: 99 }).client, HASH, LEG_OPTIONS),
        label,
      ).toEqual({ state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: false });
      expect(
        await readEip3009Legs(receiptNode({ receipt, creditBlock: 100 }).client, HASH, LEG_OPTIONS),
        label,
      ).toEqual({ state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: true });
    }
  });

  it('reads the credit tag before it checks the block is on this chain', async () => {
    let tagRead = false;
    const node = scripted({
      eth_getTransactionReceipt: () => receiptOf(pair),
      eth_getBlockByNumber: (params) => {
        if (params[0] === 'safe') {
          tagRead = true;
          return { number: hexBlock(100), hash: `0x${'ee'.repeat(32)}`, timestamp: '0x1' };
        }
        // Block 100 is replaced as the tag moves onto it.
        return {
          number: params[0],
          hash: tagRead ? `0x${'99'.repeat(32)}` : BLOCK_HASH,
          timestamp: '0x1',
        };
      },
      eth_chainId: () => '0x14a34',
    });
    expect(await readEip3009Legs(node.client, HASH, LEG_OPTIONS)).toEqual({ state: 'unreadable' });
  });

  it('matches a checksummed payee', async () => {
    expect(
      await readEip3009Legs(
        receiptNode({ receipt: receiptOf(pair), creditBlock: 100 }).client,
        HASH,
        { ...LEG_OPTIONS, to: `0x${PAYEE.slice(2).toUpperCase()}` },
      ),
    ).toMatchObject({ state: 'paid', leg: { authorizer: PAYER } });
  });

  it('takes a minimum of exactly one subunit', async () => {
    expect(
      await readEip3009Legs(receiptNode({ receipt: receiptOf(pair) }).client, HASH, {
        ...LEG_OPTIONS,
        minValue: 1n,
      }),
    ).toMatchObject({ state: 'paid' });
  });

  it('refuses a minimum below one subunit', async () => {
    await expect(
      readEip3009Legs(receiptNode({ receipt: receiptOf(pair) }).client, HASH, {
        ...LEG_OPTIONS,
        minValue: 0n,
      }),
    ).rejects.toThrow(/at least 1/);
  });
});

describe('readAuthorizationBinding', () => {
  const hit = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    from: PAYER,
    to: PAYEE,
    value: 7n,
  };
  const used = usedLog(PAYER, NONCE, { logIndex: 4 });
  const transfer = transferLog(PAYER, PAYEE, 7n, { logIndex: 5 });

  it('binds the hit to the AuthorizationUsed at index - 1', async () => {
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt: receiptOf([used, transfer]) }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        hit,
      ),
    ).toEqual({ state: 'bound', authorizer: PAYER, nonce: NONCE });
  });

  it('binds each Transfer of a batch to its own AuthorizationUsed', async () => {
    const otherNonce = `0x${'ab'.repeat(32)}`;
    const batch = receiptOf([
      usedLog(OTHER, otherNonce, { logIndex: 2 }),
      transferLog(OTHER, PAYEE, 3n, { logIndex: 3 }),
      used,
      transfer,
    ]);
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt: batch }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        hit,
      ),
    ).toEqual({ state: 'bound', authorizer: PAYER, nonce: NONCE });
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt: batch }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        { ...hit, logIndex: 3, from: OTHER, value: 3n },
      ),
    ).toEqual({ state: 'bound', authorizer: OTHER, nonce: otherNonce });
  });

  it("re-binds eth_chainId to the registry's chain id, never the caller chain's", async () => {
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt: receiptOf([used, transfer]) }).client,
        { ...BASE_SEPOLIA, evmChainId: 1 },
        USDC_BASE_DEVNET,
        hit,
      ),
    ).toEqual({ state: 'bound', authorizer: PAYER, nonce: NONCE });
  });

  it('is unreadable, never cached, on a null receipt or a mismatched tx hash, block hash or number', async () => {
    for (const [label, node] of [
      ['a null receipt', receiptNode({ receipt: null })],
      [
        'another tx hash',
        receiptNode({
          receipt: receiptOf([used, transfer], { transactionHash: `0x${'99'.repeat(32)}` }),
        }),
      ],
      [
        'another block hash',
        receiptNode({
          receipt: receiptOf(
            [
              { ...used, blockHash: `0x${'77'.repeat(32)}` },
              { ...transfer, blockHash: `0x${'77'.repeat(32)}` },
            ],
            { blockHash: `0x${'77'.repeat(32)}` },
          ),
        }),
      ],
      [
        'another block number',
        receiptNode({
          receipt: receiptOf(
            [
              { ...used, blockNumber: hexBlock(101) },
              { ...transfer, blockNumber: hexBlock(101) },
            ],
            { blockNumber: hexBlock(101) },
          ),
        }),
      ],
      [
        'a block this node does not hold',
        receiptNode({ receipt: receiptOf([used, transfer]), ownBlockHash: `0x${'77'.repeat(32)}` }),
      ],
      [
        'a hit the receipt does not hold',
        receiptNode({ receipt: receiptOf([used, transferLog(PAYER, PAYEE, 8n, { logIndex: 5 })]) }),
      ],
      ['a hit at an index the receipt does not hold', receiptNode({ receipt: receiptOf([used]) })],
      [
        'a hit whose sender the receipt does not hold',
        receiptNode({ receipt: receiptOf([used, transferLog(OTHER, PAYEE, 7n, { logIndex: 5 })]) }),
      ],
      [
        'a hit whose payee the receipt does not hold',
        receiptNode({ receipt: receiptOf([used, transferLog(PAYER, OTHER, 7n, { logIndex: 5 })]) }),
      ],
      [
        'a reverted receipt',
        receiptNode({ receipt: receiptOf([used, transfer], { status: '0x0' }) }),
      ],
      [
        'another chain id',
        receiptNode({ receipt: receiptOf([used, transfer]), chainId: '0xaa36a7' }),
      ],
    ] as const) {
      expect(
        await readAuthorizationBinding(node.client, BASE_SEPOLIA, USDC_BASE_DEVNET, hit),
        label,
      ).toEqual({ state: 'unreadable' });
    }
  });

  it('is unbound for a trusted receipt whose index - 1 log is missing, not AuthorizationUsed, or of another authorizer', async () => {
    for (const [label, logs] of [
      ['missing', [transfer]],
      ['a Transfer', [transferLog(PAYER, OTHER, 1n, { logIndex: 4 }), transfer]],
      ['another emitter', [usedLog(PAYER, NONCE, { logIndex: 4, address: OTHER }), transfer]],
      ['another authorizer', [usedLog(OTHER, NONCE, { logIndex: 4 }), transfer]],
      ['two logs back', [usedLog(PAYER, NONCE, { logIndex: 3 }), transfer]],
    ] as const) {
      expect(
        await readAuthorizationBinding(
          receiptNode({ receipt: receiptOf([...logs]) }).client,
          BASE_SEPOLIA,
          USDC_BASE_DEVNET,
          hit,
        ),
        label,
      ).toEqual({ state: 'unbound' });
    }
  });
});

describe('a terminal answer is said only about the named chain', () => {
  const pair = [
    usedLog(PAYER, NONCE, { logIndex: 4 }),
    transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
  ];
  const legLess = [transferLog(PAYER, OTHER, 1n, { logIndex: 5 })];
  const hit = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
  };
  type ChainId = string | null | undefined;
  const legs = (receipt: unknown, creditBlock: number | undefined) => (chainId: ChainId) =>
    readEip3009Legs(receiptNode({ receipt, creditBlock, chainId }).client, HASH, LEG_OPTIONS);
  const binding = (logs: ReturnType<typeof logEntry>[]) => (chainId: ChainId) =>
    readAuthorizationBinding(
      receiptNode({ receipt: receiptOf(logs), chainId }).client,
      BASE_SEPOLIA,
      USDC_BASE_DEVNET,
      hit,
    );
  const unused = (block: 'latest' | { blockHash: string }) => (chainId: ChainId) =>
    readAuthorizationUsed(
      scripted({
        eth_call: () => `0x${word(0n)}`,
        eth_chainId: () => {
          if (chainId === null) {
            throw new Error('chain id unavailable');
          }
          return chainId ?? '0x14a34';
        },
      }).client,
      BASE_SEPOLIA,
      USDC_BASE_DEVNET,
      PAYER,
      NONCE,
      block,
    );
  // Each read answers its terminal state on the named chain, and `unreadable`
  // when eth_chainId names another chain, fails, or is not a chain id.
  const CASES: { label: string; read: (chainId: ChainId) => Promise<unknown>; named: unknown }[] = [
    {
      label: 'legs: paid',
      read: legs(receiptOf(pair), undefined),
      named: { state: 'paid', leg: expect.objectContaining({ authorizer: PAYER }) },
    },
    {
      label: 'legs: none, leg-less, final',
      read: legs(receiptOf(legLess), undefined),
      named: { state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: true },
    },
    {
      label: 'legs: none, leg-less, not final',
      read: legs(receiptOf(legLess), 99),
      named: { state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: false },
    },
    {
      label: 'legs: none, reverted, final',
      read: legs(receiptOf(pair, { status: '0x0' }), undefined),
      named: { state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: true },
    },
    {
      label: 'legs: none, reverted, not final',
      read: legs(receiptOf(pair, { status: '0x0' }), 99),
      named: { state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: false },
    },
    {
      label: 'binding: bound',
      read: binding(pair),
      named: { state: 'bound', authorizer: PAYER, nonce: NONCE },
    },
    { label: 'binding: unbound, missing', read: binding([pair[1]]), named: { state: 'unbound' } },
    {
      label: 'binding: unbound, a Transfer at index - 1',
      read: binding([transferLog(PAYER, OTHER, 1n, { logIndex: 4 }), pair[1]]),
      named: { state: 'unbound' },
    },
    {
      label: 'binding: unbound, another authorizer',
      read: binding([usedLog(OTHER, NONCE, { logIndex: 4 }), pair[1]]),
      named: { state: 'unbound' },
    },
    { label: 'authorizationState: unused at latest', read: unused('latest'), named: 'unused' },
    {
      label: 'authorizationState: unused pinned',
      read: unused({ blockHash: BLOCK_HASH }),
      named: 'unused',
    },
  ];

  it.each(CASES)('$label', async ({ read, named }) => {
    expect(await read(undefined)).toEqual(named);
    const unreadable = typeof named === 'string' ? 'unreadable' : { state: 'unreadable' };
    for (const chainId of ['0xaa36a7', null, 'nonsense']) {
      expect(await read(chainId), String(chainId)).toEqual(unreadable);
    }
  });
});

describe('both receipt readers refuse a receipt missing a field the trust rules read', () => {
  const pair = [
    usedLog(PAYER, NONCE, { logIndex: 4 }),
    transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
  ];
  const hit = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
  };
  const without = (record: Record<string, unknown>, key: string) => {
    const copy = { ...record };
    delete copy[key];
    return copy;
  };
  const RECEIPT_FIELDS = ['transactionHash', 'status', 'blockNumber', 'blockHash', 'logs'];
  const LOG_FIELDS = [
    'address',
    'topics',
    'data',
    'transactionHash',
    'logIndex',
    'blockNumber',
    'blockHash',
  ];
  const RECEIPTS: { label: string; receipt: unknown }[] = [
    ...RECEIPT_FIELDS.map((key) => ({
      label: `receipt without ${key}`,
      receipt: without(receiptOf(pair), key),
    })),
    ...LOG_FIELDS.map((key) => ({
      label: `log without ${key}`,
      receipt: receiptOf([pair[0], without(pair[1], key)] as ReturnType<typeof logEntry>[]),
    })),
    { label: 'a receipt that is not an object', receipt: 'nonsense' },
  ];

  it.each(RECEIPTS)('$label', async ({ receipt }) => {
    // The complete receipt pays and binds: only the missing field makes it unreadable.
    expect(
      await readEip3009Legs(receiptNode({ receipt: receiptOf(pair) }).client, HASH, LEG_OPTIONS),
    ).toMatchObject({ state: 'paid' });
    expect(
      await readEip3009Legs(
        receiptNode({ receipt, ownBlockHash: BLOCK_HASH }).client,
        HASH,
        LEG_OPTIONS,
      ),
    ).toEqual({ state: 'unreadable' });
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt, ownBlockHash: BLOCK_HASH }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        hit,
      ),
    ).toEqual({ state: 'unreadable' });
  });
});

describe('the event and slot constants', () => {
  const keccakText = (text: string) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

  it('are the keccak of what they name', () => {
    expect(AUTHORIZATION_USED_TOPIC).toBe(keccakText('AuthorizationUsed(address,bytes32)'));
    expect(AUTHORIZATION_CANCELED_TOPIC).toBe(keccakText('AuthorizationCanceled(address,bytes32)'));
    expect(FIAT_TOKEN_IMPLEMENTATION_SLOT).toBe(keccakText('org.zeppelinos.proxy.implementation'));
    expect(APPROVAL_TOPIC).toBe(keccakText('Approval(address,address,uint256)'));
  });
});

describe('readDomainSeparator', () => {
  const SEPARATOR = expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET);

  it("calls the proxy's DOMAIN_SEPARATOR() at latest", async () => {
    const { client, calls } = scripted({ eth_call: () => SEPARATOR });
    expect(await readDomainSeparator(client, USDC_BASE_DEVNET)).toBe(SEPARATOR);
    expect(calls).toEqual([
      { method: 'eth_call', params: [{ to: USDC, data: '0x3644e515' }, 'latest'] },
    ]);
  });

  it('is null on a failed read, never a word', async () => {
    expect(await readDomainSeparator(scripted({}).client, USDC_BASE_DEVNET)).toBeNull();
    expect(
      await readDomainSeparator(scripted({ eth_call: () => '0x' }).client, USDC_BASE_DEVNET),
    ).toBeNull();
  });
});

describe('readImplementation', () => {
  const slot = (address: string) => () => `0x${word(address)}`;
  const IMPLEMENTATION = USDC_BASE_DEVNET.implementation ?? '';

  it('reads the zeppelinos slot at latest', async () => {
    const { client, calls } = scripted({ eth_getStorageAt: slot(IMPLEMENTATION) });
    expect(await readImplementation(client, USDC_BASE_DEVNET, 'latest')).toBe(IMPLEMENTATION);
    expect(calls[0]).toEqual({
      method: 'eth_getStorageAt',
      params: [USDC, FIAT_TOKEN_IMPLEMENTATION_SLOT, 'latest'],
    });
  });

  it('reads it pinned by block hash', async () => {
    const { client, calls } = scripted({ eth_getStorageAt: slot(IMPLEMENTATION) });
    expect(await readImplementation(client, USDC_BASE_DEVNET, { blockHash: BLOCK_HASH })).toBe(
      IMPLEMENTATION,
    );
    expect(calls[0]?.params[2]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
  });

  it('is null on a failed read or a dirty word, never a match', async () => {
    expect(await readImplementation(scripted({}).client, USDC_BASE_DEVNET, 'latest')).toBeNull();
    expect(
      await readImplementation(
        scripted({ eth_getStorageAt: () => `0x${'ff'.repeat(32)}` }).client,
        USDC_BASE_DEVNET,
        'latest',
      ),
    ).toBeNull();
  });
});

describe('readEip3009Preflight', () => {
  const IMPLEMENTATION = USDC_BASE_DEVNET.implementation ?? '';
  const SEPARATOR = expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET);

  function node(overrides: Record<string, Handler> = {}, calls: Record<string, Handler> = {}) {
    return scripted({
      eth_call: (params) => {
        const { data } = params[0] as { data: string };
        const selector = data.slice(0, 10);
        const override = calls[selector];
        if (override !== undefined) {
          return override(params);
        }
        if (selector === '0x5c975abb' || selector === '0xfe575a87') {
          return `0x${word(0n)}`;
        }
        if (selector === '0x70a08231') {
          return `0x${word(5_000_000n)}`;
        }
        if (selector === '0x3644e515') {
          return SEPARATOR;
        }
        throw new Error(`unexpected call ${selector}`);
      },
      eth_getBalance: () => '0xde0b6b3a7640000',
      eth_getCode: () => '0x',
      eth_getStorageAt: () => `0x${word(IMPLEMENTATION)}`,
      ...overrides,
    });
  }

  it('reads every step 2 value in one place', async () => {
    expect(
      await readEip3009Preflight(node().client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, PAYEE),
    ).toEqual({
      ok: true,
      paused: false,
      payerBlacklisted: false,
      payeeBlacklisted: false,
      tokenBalance: 5_000_000n,
      nativeBalance: 10n ** 18n,
      payerCode: { kind: 'none' },
      domainSeparator: SEPARATOR,
      domainMatches: true,
      implementation: IMPLEMENTATION,
      implementationMatches: true,
    });
  });

  it("reads the PAYER's USDC balance, native balance and code, never the payee's", async () => {
    const isPayer = (address: unknown) =>
      typeof address === 'string' && address.toLowerCase() === PAYER.toLowerCase();
    const byAddress = node(
      {
        eth_getBalance: (params) => (isPayer(params[0]) ? '0xde0b6b3a7640000' : '0x1'),
        eth_getCode: (params) => (isPayer(params[0]) ? '0x' : '0x6080604052'),
      },
      {
        '0x70a08231': (params) =>
          (params[0] as { data: string }).data.toLowerCase().endsWith(word(PAYER))
            ? `0x${word(5_000_000n)}`
            : `0x${word(1n)}`,
      },
    );
    expect(
      await readEip3009Preflight(byAddress.client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, PAYEE),
    ).toMatchObject({
      ok: true,
      tokenBalance: 5_000_000n,
      nativeBalance: 10n ** 18n,
      payerCode: { kind: 'none' },
    });
  });

  it('classifies the payer code: a 7702 designator to a known delegate, another delegate, other code', async () => {
    const read = (code: string) =>
      readEip3009Preflight(
        node({ eth_getCode: () => code }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      );
    expect(await read(`0xef0100${DELEGATOR.slice(2)}`)).toMatchObject({
      payerCode: { kind: 'delegated', delegate: DELEGATOR, known: true },
    });
    expect(await read(`0xEF0100${DELEGATOR.slice(2).toUpperCase()}`)).toMatchObject({
      payerCode: { kind: 'delegated', delegate: DELEGATOR, known: true },
    });
    expect(await read(`0xef0100${OTHER.slice(2)}`)).toMatchObject({
      payerCode: { kind: 'delegated', delegate: OTHER, known: false },
    });
    expect(await read(`0xef0100${DELEGATOR.slice(2)}00`)).toMatchObject({
      payerCode: { kind: 'other' },
    });
    expect(await read('0x6080604052')).toMatchObject({ payerCode: { kind: 'other' } });
  });

  it('reports a domain or implementation mismatch, blacklists and pause', async () => {
    expect(
      await readEip3009Preflight(
        node({ eth_getStorageAt: () => `0x${word(OTHER)}` }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      ),
    ).toMatchObject({ ok: true, implementation: OTHER, implementationMatches: false });
    expect(
      await readEip3009Preflight(
        node({}, { '0x3644e515': () => `0x${'12'.repeat(32)}` }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      ),
    ).toMatchObject({ ok: true, domainMatches: false });
    const listed = (address: string) => (params: readonly unknown[]) =>
      (params[0] as { data: string }).data.endsWith(address.slice(2))
        ? `0x${word(1n)}`
        : `0x${word(0n)}`;
    expect(
      await readEip3009Preflight(
        node({}, { '0xfe575a87': listed(PAYER), '0x5c975abb': () => `0x${word(1n)}` }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      ),
    ).toMatchObject({ paused: true, payerBlacklisted: true, payeeBlacklisted: false });
    expect(
      await readEip3009Preflight(
        node({}, { '0xfe575a87': listed(PAYEE) }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      ),
    ).toMatchObject({ payerBlacklisted: false, payeeBlacklisted: true });
  });

  it("pins the registry's implementation and delegates, never the caller's objects", async () => {
    for (const implementation of [undefined, 'nonsense', OTHER]) {
      expect(
        await readEip3009Preflight(
          node({ eth_getStorageAt: () => `0x${word(OTHER)}` }).client,
          BASE_SEPOLIA,
          { ...USDC_BASE_DEVNET, implementation },
          PAYER,
          PAYEE,
        ),
      ).toMatchObject({ ok: true, implementation: OTHER, implementationMatches: false });
    }
    expect(
      await readEip3009Preflight(
        node({ eth_getCode: () => `0xef0100${OTHER.slice(2)}` }).client,
        { ...BASE_SEPOLIA, knownDelegates: [OTHER] },
        USDC_BASE_DEVNET,
        PAYER,
        PAYEE,
      ),
    ).toMatchObject({ payerCode: { kind: 'delegated', delegate: OTHER, known: false } });
  });

  it('is not ok when ANY read fails, never a pass', async () => {
    const failures: [string, Record<string, Handler>, Record<string, Handler>][] = [
      ['paused', {}, { '0x5c975abb': () => '0x' }],
      ['a blacklist', {}, { '0xfe575a87': () => `0x${word(2n)}` }],
      [
        "the payer's blacklist",
        {},
        {
          '0xfe575a87': (params) =>
            (params[0] as { data: string }).data.endsWith(word(PAYER)) ? '0x' : `0x${word(0n)}`,
        },
      ],
      [
        "the payee's blacklist",
        {},
        {
          '0xfe575a87': (params) =>
            (params[0] as { data: string }).data.endsWith(word(PAYEE)) ? '0x' : `0x${word(0n)}`,
        },
      ],
      ['the balance', {}, { '0x70a08231': () => '0x' }],
      ['the domain', {}, { '0x3644e515': () => '0x' }],
      ['the native balance', { eth_getBalance: () => null }, {}],
      ['the code', { eth_getCode: () => 'nonsense' }, {}],
      ['the implementation', { eth_getStorageAt: () => '0x' }, {}],
    ];
    for (const [label, overrides, calls] of failures) {
      expect(
        await readEip3009Preflight(
          node(overrides, calls).client,
          BASE_SEPOLIA,
          USDC_BASE_DEVNET,
          PAYER,
          PAYEE,
        ),
        label,
      ).toEqual({ ok: false });
    }
  });
});

describe('estimateTransferWithAuthorization', () => {
  const CALLDATA = '0xcf092995abcd';

  it('estimates the signed call WITHOUT fee fields, and the fee cap 2 x base fee + priority', async () => {
    const { client, calls } = scripted({
      eth_estimateGas: () => '0x19a28',
      eth_getBlockByNumber: () => ({
        number: '0x1',
        hash: BLOCK_HASH,
        timestamp: '0x1',
        baseFeePerGas: '0x64',
      }),
      eth_maxPriorityFeePerGas: () => '0xa',
    });
    expect(await estimateTransferWithAuthorization(client, BASE_SEPOLIA, PAYER, CALLDATA)).toEqual({
      kind: 'ok',
      gas: 105_000n,
      feeCap: 210n,
    });
    expect(calls[0]).toEqual({
      method: 'eth_estimateGas',
      params: [{ from: PAYER, to: USDC, data: CALLDATA }, 'latest'],
    });
  });

  it('keeps an execution error apart from a transport failure', async () => {
    for (const code of [3, -32000, -32015]) {
      expect(
        await estimateTransferWithAuthorization(
          scripted({
            eth_estimateGas: () => {
              throw new EvmRpcError('eth_estimateGas', { code, message: 'execution reverted' });
            },
          }).client,
          BASE_SEPOLIA,
          PAYER,
          CALLDATA,
        ),
      ).toEqual({ kind: 'execution_error' });
    }
    for (const thrown of [
      new Error('rpc eth_estimateGas answered HTTP 429'),
      new EvmRpcError('eth_estimateGas', { code: -32005, message: 'rate limit' }),
      Object.assign(new Error('The rpc request was abandoned'), { name: 'AbortError' }),
    ]) {
      expect(
        await estimateTransferWithAuthorization(
          scripted({
            eth_estimateGas: () => {
              throw thrown;
            },
          }).client,
          BASE_SEPOLIA,
          PAYER,
          CALLDATA,
        ),
      ).toEqual({ kind: 'transport_error' });
    }
    // A failed fee read after a good estimate is transport too.
    // So is an estimate that is not a quantity.
    expect(
      await estimateTransferWithAuthorization(
        scripted({
          eth_estimateGas: () => 'nonsense',
          eth_getBlockByNumber: () => ({
            number: '0x1',
            hash: BLOCK_HASH,
            timestamp: '0x1',
            baseFeePerGas: '0x64',
          }),
          eth_maxPriorityFeePerGas: () => '0xa',
        }).client,
        BASE_SEPOLIA,
        PAYER,
        CALLDATA,
      ),
    ).toEqual({ kind: 'transport_error' });
    expect(
      await estimateTransferWithAuthorization(
        scripted({
          eth_estimateGas: () => '0x1',
          eth_getBlockByNumber: () => ({ number: '0x1' }),
          eth_maxPriorityFeePerGas: () => '0x1',
        }).client,
        BASE_SEPOLIA,
        PAYER,
        CALLDATA,
      ),
    ).toEqual({ kind: 'transport_error' });
  });
});

describe('readL1Fee', () => {
  it("reads the OP-stack getL1Fee of the calldata, encoded as viem's ABI encoder", async () => {
    const { client, calls } = scripted({ eth_call: () => `0x${word(1_090_000_000n)}` });
    expect(await readL1Fee(client, BASE_SEPOLIA, '0x0102030405')).toBe(1_090_000_000n);
    expect(calls[0]).toEqual({
      method: 'eth_call',
      params: [
        {
          to: '0x420000000000000000000000000000000000000f',
          data: '0x49948e0e000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000050102030405000000000000000000000000000000000000000000000000000000',
        },
        'latest',
      ],
    });
  });

  it("reads the registry's oracle, never the caller chain's, and refuses one the registry lacks", async () => {
    const { client, calls } = scripted({ eth_call: () => `0x${word(1n)}` });
    await readL1Fee(client, { ...BASE_SEPOLIA, l1FeeOracle: OTHER }, '0x01');
    expect((calls[0]?.params[0] as { to: string } | undefined)?.to).toBe(
      '0x420000000000000000000000000000000000000f',
    );
    await expect(
      readL1Fee(client, { ...CHAINS.ARBITRUM_DEVNET, l1FeeOracle: OTHER }, '0x01'),
    ).rejects.toThrow(/L1 fee oracle/);
  });

  it('is called only for a chain with l1FeeOracle', async () => {
    const { client, calls } = scripted({ eth_call: () => `0x${word(1n)}` });
    await expect(readL1Fee(client, CHAINS.ARBITRUM_DEVNET, '0x01')).rejects.toThrow(
      /L1 fee oracle/,
    );
    await expect(readL1Fee(client, CHAINS.ETHEREUM_MAINNET, '0x01')).rejects.toThrow(
      /L1 fee oracle/,
    );
    expect(calls).toEqual([]);
  });

  it('is null on a failed read, never 0', async () => {
    expect(await readL1Fee(scripted({}).client, BASE_SEPOLIA, '0x01')).toBeNull();
    expect(
      await readL1Fee(scripted({ eth_call: () => '0x' }).client, BASE_SEPOLIA, '0x01'),
    ).toBeNull();
  });
});

describe('every reader takes its hex inputs in any case', () => {
  /** The same hex with every letter upper-cased, the `0x` prefix kept. */
  const upper = (hex: string) => `0x${hex.slice(2).toUpperCase()}`;
  const SIGNATURE =
    '0xe602c0f6622a611835d8665c5406628a50419ee2a766829ef4f714150d61ab23219b2e9de3c504a33b22e85362897a72c8bbfd6bbef2fb421e8a5eddfd5251d61b';

  it('builds, normalizes and encodes the same authorization', () => {
    const lower = authorization();
    expect(authorization({ from: upper(PAYER), to: upper(PAYEE), nonce: upper(NONCE) })).toEqual(
      lower,
    );
    const { r, s, recovery } = sign(lower);
    const signature = `0x${r}${s.toString(16).padStart(64, '0')}${(27 + recovery).toString(16)}`;
    const normalized = normalizeAuthorizationSignature(lower, signature, PAYER);
    expect(normalized).toMatch(/^0x[0-9a-f]{130}$/);
    expect(normalizeAuthorizationSignature(lower, upper(signature), upper(PAYER))).toBe(normalized);
    expect(
      encodeTransferWithAuthorization(
        { ...lower.message, from: upper(PAYER), to: upper(PAYEE), nonce: upper(NONCE) },
        upper(SIGNATURE),
      ),
    ).toBe(encodeTransferWithAuthorization(lower.message, SIGNATURE));
  });

  it('asks authorizationState and the pinned slot the same thing', async () => {
    const ask = async (authorizer: string, nonce: string, blockHash: string) => {
      const { client, calls } = scripted({
        eth_call: () => `0x${word(0n)}`,
        eth_chainId: () => '0x14a34',
        eth_getStorageAt: () => `0x${word(USDC_BASE_DEVNET.implementation ?? '')}`,
      });
      const state = await readAuthorizationUsed(
        client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        authorizer,
        nonce,
        { blockHash },
      );
      const implementation = await readImplementation(client, USDC_BASE_DEVNET, { blockHash });
      return { state, implementation, calls };
    };
    const lower = await ask(PAYER, NONCE, BLOCK_HASH);
    expect(lower.state).toBe('unused');
    expect(await ask(upper(PAYER), upper(NONCE), upper(BLOCK_HASH))).toEqual(lower);
  });

  it('finds the same cancel', async () => {
    const cancel = logEntry({
      topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE],
      block: 1000,
    });
    const scan = async (authorizer: string, nonce: string) => {
      const { client, calls } = scripted({ eth_getLogs: logsByRange([cancel], 1000) });
      const found = await readAuthorizationCanceled(
        client,
        USDC_BASE_DEVNET,
        authorizer,
        nonce,
        1000,
        1999,
      );
      return { found, calls };
    };
    const lower = await scan(PAYER, NONCE);
    expect(lower.found).toEqual({ state: 'canceled', requests: 1 });
    expect(await scan(upper(PAYER), upper(NONCE))).toEqual(lower);
  });

  it('lists the same transfers to a payout', async () => {
    const list = async (payout: string) => {
      const { client, calls } = scripted({
        eth_getLogs: logsByRange([transferLog(PAYER, PAYEE, 5n, { block: 1000 })], 1000),
      });
      const walk = await listPayoutTransfers(client, USDC_BASE_DEVNET, payout, 1000, 1999);
      return { walk, calls };
    };
    const lower = await list(PAYEE);
    expect(lower.walk).toMatchObject({ complete: true, logs: [{ to: PAYEE }] });
    expect(await list(upper(PAYEE))).toEqual(lower);
  });

  it('reads the same paid leg', async () => {
    const pair = [
      usedLog(PAYER, NONCE, { logIndex: 4 }),
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
    ];
    const legs = (hash: string, nonce: string, to: string) =>
      readEip3009Legs(receiptNode({ receipt: receiptOf(pair), creditBlock: 100 }).client, hash, {
        ...LEG_OPTIONS,
        nonce,
        to,
      });
    const lower = await legs(HASH, NONCE, PAYEE);
    expect(lower.state).toBe('paid');
    expect(await legs(upper(HASH), upper(NONCE), upper(PAYEE))).toEqual(lower);
  });

  it('binds the same hit', async () => {
    const pair = [
      usedLog(PAYER, NONCE, { logIndex: 4 }),
      transferLog(PAYER, PAYEE, 7n, { logIndex: 5 }),
    ];
    const bind = (hit: { txHash: string; blockHash: string; from: string; to: string }) =>
      readAuthorizationBinding(
        receiptNode({ receipt: receiptOf(pair) }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        { ...hit, blockNumber: 100, logIndex: 5, value: 7n },
      );
    const lower = await bind({ txHash: HASH, blockHash: BLOCK_HASH, from: PAYER, to: PAYEE });
    expect(lower).toEqual({ state: 'bound', authorizer: PAYER, nonce: NONCE });
    expect(
      await bind({
        txHash: upper(HASH),
        blockHash: upper(BLOCK_HASH),
        from: upper(PAYER),
        to: upper(PAYEE),
      }),
    ).toEqual(lower);
  });

  it('asks the same preflight and estimate', async () => {
    const IMPLEMENTATION = USDC_BASE_DEVNET.implementation ?? '';
    const SEPARATOR = expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET);
    const preflight = async (payer: string, payee: string) => {
      const { client, calls } = scripted({
        eth_call: (params) => {
          const selector = (params[0] as { data: string }).data.slice(0, 10);
          if (selector === '0x70a08231') {
            return `0x${word(5_000_000n)}`;
          }
          return selector === '0x3644e515' ? SEPARATOR : `0x${word(0n)}`;
        },
        eth_getBalance: () => '0x1',
        eth_getCode: () => '0x',
        eth_getStorageAt: () => `0x${word(IMPLEMENTATION)}`,
      });
      const read = await readEip3009Preflight(client, BASE_SEPOLIA, USDC_BASE_DEVNET, payer, payee);
      return { read, calls };
    };
    const lowerPreflight = await preflight(PAYER, PAYEE);
    expect(lowerPreflight.read).toMatchObject({ ok: true });
    expect(await preflight(upper(PAYER), upper(PAYEE))).toEqual(lowerPreflight);

    const estimate = async (payer: string, calldata: string) => {
      const { client, calls } = scripted({
        eth_estimateGas: () => '0x19a28',
        eth_getBlockByNumber: () => ({
          number: '0x1',
          hash: BLOCK_HASH,
          timestamp: '0x1',
          baseFeePerGas: '0x64',
        }),
        eth_maxPriorityFeePerGas: () => '0xa',
      });
      const answer = await estimateTransferWithAuthorization(client, BASE_SEPOLIA, payer, calldata);
      return { answer, calls };
    };
    const lowerEstimate = await estimate(PAYER, '0xcf092995abcd');
    expect(lowerEstimate.answer).toMatchObject({ kind: 'ok' });
    expect(await estimate(upper(PAYER), '0xCF092995ABCD')).toEqual(lowerEstimate);

    const l1Fee = async (calldata: string) => {
      const { client, calls } = scripted({ eth_call: () => `0x${word(1_090_000_000n)}` });
      const fee = await readL1Fee(client, BASE_SEPOLIA, calldata);
      return { fee, calls };
    };
    const lowerFee = await l1Fee('0xcf092995abcd');
    expect(lowerFee.fee).toBe(1_090_000_000n);
    expect(await l1Fee('0xCF092995ABCD')).toEqual(lowerFee);
  });
});

describe('every reader fails closed on each RPC call it makes', () => {
  const IMPLEMENTATION = USDC_BASE_DEVNET.implementation ?? '';
  const SEPARATOR = expectedDomainSeparator(BASE_SEPOLIA, USDC_BASE_DEVNET);
  const TAG_BLOCK = 1_000_000_000;
  const MODES = ['throw', 'null', 'not hex', 'an object'] as const;
  type Mode = (typeof MODES)[number];

  function brokenAnswer(mode: Mode): unknown {
    if (mode === 'throw') {
      throw new Error('the endpoint failed');
    }
    if (mode === 'null') {
      return null;
    }
    return mode === 'not hex' ? '0xzz' : {};
  }

  /** The call's key: its method, the selector of an `eth_call`, the kind of block asked for. */
  function keyOf(method: string, params: readonly unknown[]): string {
    if (method === 'eth_call') {
      const { data } = params[0] as { data: string };
      const selector = data.slice(0, 10);
      if (selector === '0xfe575a87') {
        return `eth_call:${selector}:${data.endsWith(word(PAYER)) ? 'payer' : 'payee'}`;
      }
      return `eth_call:${selector}`;
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0];
      return `eth_getBlockByNumber:${typeof tag === 'string' && tag.startsWith('0x') ? 'number' : String(tag)}`;
    }
    return method;
  }

  function healthyAnswer(
    key: string,
    params: readonly unknown[],
    receipt: unknown,
    logs: unknown[],
  ): unknown {
    switch (key) {
      case 'eth_call:0x5c975abb':
      case 'eth_call:0xfe575a87:payer':
      case 'eth_call:0xfe575a87:payee':
      case 'eth_call:0xe94a0102':
        return `0x${word(0n)}`;
      case 'eth_call:0x70a08231':
        return `0x${word(5_000_000n)}`;
      case 'eth_call:0x3644e515':
        return SEPARATOR;
      case 'eth_call:0x49948e0e':
        return `0x${word(1_090_000_000n)}`;
      case 'eth_getBlockByNumber:number':
        return { number: params[0], hash: BLOCK_HASH, timestamp: '0x1', baseFeePerGas: '0x64' };
      case 'eth_getBlockByNumber:latest':
      case 'eth_getBlockByNumber:safe':
      case 'eth_getBlockByNumber:finalized':
        return {
          number: hexBlock(TAG_BLOCK),
          hash: `0x${'ee'.repeat(32)}`,
          timestamp: '0x1',
          baseFeePerGas: '0x64',
        };
      case 'eth_chainId':
        return '0x14a34';
      case 'eth_getTransactionReceipt':
        return receipt;
      case 'eth_getLogs':
        return logs;
      case 'eth_getBalance':
        return '0xde0b6b3a7640000';
      case 'eth_getCode':
        return '0x';
      case 'eth_getStorageAt':
        return `0x${word(IMPLEMENTATION)}`;
      case 'eth_estimateGas':
        return '0x19a28';
      case 'eth_maxPriorityFeePerGas':
        return '0xa';
      default:
        throw new Error(`unscripted ${key}`);
    }
  }

  /** A node answering every call well, but for `broken`, which answers as `mode` says. */
  function node(options: { receipt?: unknown; logs?: unknown[]; broken?: string; mode?: Mode }) {
    const keys: string[] = [];
    const calls: { method: string; params: readonly unknown[] }[] = [];
    const client = {
      request: async ({ method, params = [] }: { method: string; params?: readonly unknown[] }) => {
        const key = keyOf(method, params);
        keys.push(key);
        calls.push({ method, params });
        if (key === options.broken && options.mode !== undefined) {
          return brokenAnswer(options.mode);
        }
        return healthyAnswer(key, params, options.receipt ?? null, options.logs ?? []);
      },
    };
    return { client, keys, calls };
  }

  const paying = receiptOf([
    usedLog(PAYER, NONCE, { logIndex: 4 }),
    transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
  ]);
  const legless = receiptOf([transferLog(PAYER, OTHER, 1n, { logIndex: 5 })]);
  const hit = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
  };

  interface Case {
    reader: string;
    receipt?: unknown;
    logs?: unknown[];
    run: (client: ReturnType<typeof node>['client']) => Promise<unknown>;
    healthy: unknown;
    failed: unknown;
    /** What a `null` receipt means, when the reader documents it otherwise. */
    nullReceipt?: unknown;
  }

  const CASES: Case[] = [
    {
      reader: 'readDomainSeparator',
      run: (client) => readDomainSeparator(client, USDC_BASE_DEVNET),
      healthy: SEPARATOR,
      failed: null,
    },
    ...(['latest', 'safe', 'finalized'] as const).map((tag) => ({
      reader: `readBlockAtTag ${tag}`,
      run: (client: ReturnType<typeof node>['client']) => readBlockAtTag(client, tag),
      healthy: { number: TAG_BLOCK, hash: `0x${'ee'.repeat(32)}`, timestamp: 1 },
      failed: null,
    })),
    {
      reader: 'readFinalizedBlockWithHash',
      run: (client) => readFinalizedBlockWithHash(client),
      healthy: { number: TAG_BLOCK, hash: `0x${'ee'.repeat(32)}`, timestamp: 1 },
      failed: null,
    },
    ...(['latest', { blockHash: BLOCK_HASH }] as const).map((block) => ({
      reader: `readAuthorizationUsed ${typeof block === 'string' ? block : 'pinned'}`,
      run: (client: ReturnType<typeof node>['client']) =>
        readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, NONCE, block),
      healthy: 'unused',
      failed: 'unreadable',
    })),
    {
      reader: 'readAuthorizationCanceled',
      run: (client) => readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, NONCE, 100, 100),
      healthy: { state: 'not_canceled', requests: 1 },
      failed: { state: 'unreadable', requests: 1 },
    },
    {
      reader: 'listPayoutTransfers',
      run: (client) => listPayoutTransfers(client, USDC_BASE_DEVNET, PAYEE, 100, 100),
      healthy: { complete: true, logs: [], requests: 1 },
      failed: { complete: false, requests: 1 },
    },
    {
      reader: 'listAuthorizationsByNonce',
      run: (client) => listAuthorizationsByNonce(client, USDC_BASE_DEVNET, NONCE, 100, 100),
      healthy: { complete: true, logs: [], requests: 1 },
      failed: { complete: false, requests: 1 },
    },
    {
      reader: 'findAssetTransferNear',
      logs: [transferLog(PAYER, PAYEE, 1n, { logIndex: 5 })],
      run: (client) => findAssetTransferNear(client, USDC_BASE_DEVNET, 100, 1),
      healthy: { state: 'found', requests: 1 },
      failed: { state: 'unreadable', requests: 1 },
    },
    {
      reader: 'readEip3009Legs on a paying receipt',
      receipt: paying,
      run: (client) => readEip3009Legs(client, HASH, LEG_OPTIONS),
      healthy: { state: 'paid' },
      failed: { state: 'unreadable' },
      nullReceipt: { state: 'absent' },
    },
    {
      reader: 'readEip3009Legs on a receipt without the leg',
      receipt: legless,
      run: (client) => readEip3009Legs(client, HASH, LEG_OPTIONS),
      healthy: { state: 'none', final: true },
      failed: { state: 'unreadable' },
      nullReceipt: { state: 'absent' },
    },
    {
      reader: 'readAuthorizationBinding',
      receipt: paying,
      run: (client) => readAuthorizationBinding(client, BASE_SEPOLIA, USDC_BASE_DEVNET, hit),
      healthy: { state: 'bound', authorizer: PAYER, nonce: NONCE },
      failed: { state: 'unreadable' },
    },
    {
      reader: 'readEip3009Preflight',
      run: (client) => readEip3009Preflight(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, PAYEE),
      healthy: { ok: true, domainMatches: true, implementationMatches: true },
      failed: { ok: false },
    },
    {
      reader: 'readImplementation',
      run: (client) => readImplementation(client, USDC_BASE_DEVNET, 'latest'),
      healthy: IMPLEMENTATION,
      failed: null,
    },
    {
      reader: 'estimateTransferWithAuthorization',
      run: (client) => estimateTransferWithAuthorization(client, BASE_SEPOLIA, PAYER, '0xcf092995'),
      healthy: { kind: 'ok', gas: 0x19a28n, feeCap: 2n * 0x64n + 0xan },
      failed: { kind: 'transport_error' },
    },
    {
      reader: 'readL1Fee',
      run: (client) => readL1Fee(client, BASE_SEPOLIA, '0xcf092995'),
      healthy: 1_090_000_000n,
      failed: null,
    },
  ];

  function expectLike(actual: unknown, expected: unknown, label: string): void {
    if (typeof expected === 'object' && expected !== null) {
      expect(actual, label).toMatchObject(expected);
    } else {
      expect(actual, label).toEqual(expected);
    }
  }

  /**
   * Every call each reader makes, in full: method, target, selector and data,
   * and the block it is asked at (a tag, a number, or an EIP-1898 pin). The
   * selectors are written out, not imported, so a changed target, tag or
   * selector is caught here and not taken from the code under test.
   */
  const LATEST_CALL = (data: string) => ({
    method: 'eth_call',
    params: [{ to: USDC, data }, 'latest'],
  });
  const BLOCK_AT = (tag: string) => ({ method: 'eth_getBlockByNumber', params: [tag, false] });
  const CHAIN_ID = { method: 'eth_chainId', params: [] };
  const RECEIPT = { method: 'eth_getTransactionReceipt', params: [HASH] };
  const AUTHORIZATION_STATE = `0xe94a0102${word(PAYER)}${NONCE.slice(2)}`;
  const IMPLEMENTATION_AT_LATEST = {
    method: 'eth_getStorageAt',
    params: [USDC, FIAT_TOKEN_IMPLEMENTATION_SLOT, 'latest'],
  };
  const LOGS_AT_100 = (topics: (string | null)[]) => ({
    method: 'eth_getLogs',
    params: [{ address: USDC, topics, fromBlock: hexBlock(100), toBlock: hexBlock(100) }],
  });
  const CALLS: Record<string, unknown[]> = {
    readDomainSeparator: [LATEST_CALL('0x3644e515')],
    'readBlockAtTag latest': [BLOCK_AT('latest')],
    'readBlockAtTag safe': [BLOCK_AT('safe')],
    'readBlockAtTag finalized': [BLOCK_AT('finalized')],
    readFinalizedBlockWithHash: [BLOCK_AT('finalized')],
    'readAuthorizationUsed latest': [LATEST_CALL(AUTHORIZATION_STATE), CHAIN_ID],
    'readAuthorizationUsed pinned': [
      {
        method: 'eth_call',
        params: [
          { to: USDC, data: AUTHORIZATION_STATE },
          { blockHash: BLOCK_HASH, requireCanonical: true },
        ],
      },
      CHAIN_ID,
    ],
    readAuthorizationCanceled: [
      LOGS_AT_100([AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE]),
    ],
    listPayoutTransfers: [LOGS_AT_100([TRANSFER_TOPIC, null, `0x${word(PAYEE)}`])],
    listAuthorizationsByNonce: [LOGS_AT_100([AUTHORIZATION_USED_TOPIC, null, NONCE])],
    findAssetTransferNear: [LOGS_AT_100([TRANSFER_TOPIC])],
    'readEip3009Legs on a paying receipt': [
      RECEIPT,
      BLOCK_AT('safe'),
      BLOCK_AT(hexBlock(100)),
      CHAIN_ID,
    ],
    'readEip3009Legs on a receipt without the leg': [
      RECEIPT,
      BLOCK_AT('safe'),
      BLOCK_AT(hexBlock(100)),
      CHAIN_ID,
    ],
    readAuthorizationBinding: [RECEIPT, BLOCK_AT(hexBlock(100)), CHAIN_ID],
    readEip3009Preflight: [
      LATEST_CALL('0x5c975abb'),
      LATEST_CALL(`0xfe575a87${word(PAYER)}`),
      LATEST_CALL(`0xfe575a87${word(PAYEE)}`),
      LATEST_CALL(`0x70a08231${word(PAYER)}`),
      { method: 'eth_getBalance', params: [PAYER, 'latest'] },
      { method: 'eth_getCode', params: [PAYER, 'latest'] },
      LATEST_CALL('0x3644e515'),
      IMPLEMENTATION_AT_LATEST,
    ],
    readImplementation: [IMPLEMENTATION_AT_LATEST],
    estimateTransferWithAuthorization: [
      {
        method: 'eth_estimateGas',
        params: [{ from: PAYER, to: USDC, data: '0xcf092995' }, 'latest'],
      },
      BLOCK_AT('latest'),
      { method: 'eth_maxPriorityFeePerGas', params: [] },
    ],
    readL1Fee: [
      {
        method: 'eth_call',
        params: [
          {
            to: '0x420000000000000000000000000000000000000f',
            data: `0x49948e0e${word(0x20n)}${word(4n)}${'cf092995'.padEnd(64, '0')}`,
          },
          'latest',
        ],
      },
    ],
  };

  it('names a full call list for every reader in the table', () => {
    expect(Object.keys(CALLS).sort()).toEqual(CASES.map((testCase) => testCase.reader).sort());
  });

  it.each(CASES)('$reader asks each call with exactly these params', async (testCase) => {
    const healthy = node({ receipt: testCase.receipt, logs: testCase.logs });
    await testCase.run(healthy.client);
    expect(healthy.calls).toEqual(CALLS[testCase.reader]);
  });

  it.each(CASES)('$reader', async (testCase) => {
    const healthy = node({ receipt: testCase.receipt, logs: testCase.logs });
    expectLike(await testCase.run(healthy.client), testCase.healthy, 'healthy');
    const asked = [...new Set(healthy.keys)];
    expect(asked.length).toBeGreaterThan(0);
    for (const key of asked) {
      for (const mode of MODES) {
        const label = `${key} answering ${mode}`;
        const broken = node({ receipt: testCase.receipt, logs: testCase.logs, broken: key, mode });
        const answer = await testCase.run(broken.client);
        const expected =
          key === 'eth_getTransactionReceipt' && mode === 'null' && testCase.nullReceipt
            ? testCase.nullReceipt
            : testCase.failed;
        if (typeof expected === 'object' && expected !== null) {
          expect(answer, label).toEqual(expect.objectContaining(expected));
          expect(answer, label).not.toMatchObject(testCase.healthy as object);
        } else {
          expect(answer, label).toEqual(expected);
        }
      }
    }
  });
});

describe('a reader refuses an asset of another chain before any request', () => {
  const MISMATCHES: readonly (readonly [string, ChainConfig, Asset])[] = [
    ['Base mainnet with Base Sepolia USDC', CHAINS.BASE_MAINNET, USDC_BASE_DEVNET],
    ['Arbitrum One with Base USDC', CHAINS.ARBITRUM_MAINNET, USDC_BASE_MAINNET],
  ];
  const HIT = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 1,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
  };
  const READERS: readonly (readonly [
    string,
    (client: ReturnType<typeof scripted>['client'], chain: ChainConfig, asset: Asset) => unknown,
  ])[] = [
    [
      'readAuthorizationUsed',
      (client, chain, asset) => readAuthorizationUsed(client, chain, asset, PAYER, NONCE, 'latest'),
    ],
    [
      'readEip3009Legs',
      (client, chain, asset) =>
        readEip3009Legs(client, HASH, { chain, asset, nonce: NONCE, to: PAYEE, minValue: 1n }),
    ],
    [
      'readAuthorizationBinding',
      (client, chain, asset) => readAuthorizationBinding(client, chain, asset, HIT),
    ],
    [
      'readEip3009Preflight',
      (client, chain, asset) => readEip3009Preflight(client, chain, asset, PAYER, PAYEE),
    ],
    ['expectedDomainSeparator', (_client, chain, asset) => expectedDomainSeparator(chain, asset)],
  ];

  for (const [pairing, chain, asset] of MISMATCHES) {
    for (const [name, read] of READERS) {
      it(`${name}: ${pairing}`, async () => {
        const { client, calls } = scripted({ eth_chainId: () => '0xaa36a7' });
        const answer = async (): Promise<unknown> => read(client, chain, asset);
        await expect(answer()).rejects.toThrow(/not an EIP-3009 coin/);
        expect(calls).toHaveLength(0);
      });
    }
  }
});

describe('normalizeAuthorizationSignature keeps the leading zeros of r and s', () => {
  // Values whose deterministic signature by SECRET starts r or s with a zero
  // nibble or a whole zero byte: about one real signature in six.
  const CASES: readonly (readonly [string, bigint])[] = [
    ['r starts with a zero nibble', 13n],
    ['s starts with a zero nibble', 16n],
    ['r starts with a zero byte', 23n],
    ['s starts with a zero byte', 30n],
  ];

  for (const [label, value] of CASES) {
    it(label, () => {
      const typedData = authorization({ value });
      const { r, s, recovery } = sign(typedData);
      expect(`${r}${word(s)}`).toMatch(/^0|^[0-9a-f]{64}0/);
      const expected = `0x${r}${word(s)}${(27 + recovery).toString(16)}`;
      const normalized = normalizeAuthorizationSignature(typedData, expected, PAYER);
      expect(normalized).toBe(expected);
      expect(normalized).toHaveLength(2 + 65 * 2);
      // The same signature with a high s folds back to that zero-led low s.
      const high = `0x${r}${word(N - s)}${(28 - recovery).toString(16)}`;
      expect(normalizeAuthorizationSignature(typedData, high, PAYER)).toBe(expected);
    });
  }
});

describe('readEip3009Legs pairs by log index, never by array position', () => {
  it('refuses a Transfer two indexes on, with no log between them in the answer', async () => {
    const gap = [
      usedLog(PAYER, NONCE, { logIndex: 4 }),
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 6 }),
    ];
    expect(
      await readEip3009Legs(receiptNode({ receipt: receiptOf(gap) }).client, HASH, LEG_OPTIONS),
    ).toEqual({ state: 'none', blockNumber: 100, blockHash: BLOCK_HASH, final: true });
  });

  it('credits the adjacent pair a node lists out of index order', async () => {
    const shuffled = [
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
      usedLog(PAYER, NONCE, { logIndex: 4 }),
    ];
    expect(
      await readEip3009Legs(
        receiptNode({ receipt: receiptOf(shuffled) }).client,
        HASH,
        LEG_OPTIONS,
      ),
    ).toEqual({
      state: 'paid',
      leg: {
        txHash: HASH,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        logIndex: 5,
        authorizer: PAYER,
        value: 1_000_000n,
      },
    });
  });
});

describe('every builder and reader refuses a malformed input before any request', () => {
  const BAD_ADDRESS = '0x1234';
  const BAD_HASH = '0x1234';
  const BAD_NONCE = '0x12';
  const HIT = {
    txHash: HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    from: PAYER,
    to: PAYEE,
    value: 1_000_000n,
  };
  const message = authorization().message;
  const SIGNATURE = `0x${'11'.repeat(65)}`;
  type Client = ReturnType<typeof scripted>['client'];
  const CASES: readonly (readonly [string, (client: Client) => unknown, RegExp])[] = [
    ['build: from', () => authorization({ from: BAD_ADDRESS }), /from is not an EVM address/],
    ['build: to', () => authorization({ to: BAD_ADDRESS }), /to is not an EVM address/],
    ['build: nonce', () => authorization({ nonce: BAD_NONCE }), /nonce must be 32 bytes/],
    [
      'encode: from',
      () => encodeTransferWithAuthorization({ ...message, from: BAD_ADDRESS }, SIGNATURE),
      /from is not an EVM address/,
    ],
    [
      'encode: to',
      () => encodeTransferWithAuthorization({ ...message, to: BAD_ADDRESS }, SIGNATURE),
      /to is not an EVM address/,
    ],
    [
      'encode: nonce',
      () => encodeTransferWithAuthorization({ ...message, nonce: BAD_NONCE }, SIGNATURE),
      /nonce must be 32 bytes/,
    ],
    [
      'encode: signature',
      () => encodeTransferWithAuthorization(message, 'not hex'),
      /signature is not hex/,
    ],
    [
      'readAuthorizationUsed: authorizer',
      (client) =>
        readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, BAD_ADDRESS, NONCE, 'latest'),
      /authorizer is not an EVM address/,
    ],
    [
      'readAuthorizationUsed: nonce',
      (client) =>
        readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, BAD_NONCE, 'latest'),
      /nonce must be 32 bytes/,
    ],
    [
      'readAuthorizationUsed: pinned block hash',
      (client) =>
        readAuthorizationUsed(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, NONCE, {
          blockHash: BAD_HASH,
        }),
      /Not a block hash/,
    ],
    [
      'readImplementation: pinned block hash',
      (client) => readImplementation(client, USDC_BASE_DEVNET, { blockHash: BAD_HASH }),
      /Not a block hash/,
    ],
    [
      'readAuthorizationCanceled: authorizer',
      (client) => readAuthorizationCanceled(client, USDC_BASE_DEVNET, BAD_ADDRESS, NONCE, 0, 5),
      /authorizer is not an EVM address/,
    ],
    [
      'readAuthorizationCanceled: nonce',
      (client) => readAuthorizationCanceled(client, USDC_BASE_DEVNET, PAYER, BAD_NONCE, 0, 5),
      /nonce must be 32 bytes/,
    ],
    [
      'listPayoutTransfers: payout',
      (client) => listPayoutTransfers(client, USDC_BASE_DEVNET, BAD_ADDRESS, 0, 5),
      /payout is not an EVM address/,
    ],
    [
      'listAuthorizationsByNonce: nonce',
      (client) => listAuthorizationsByNonce(client, USDC_BASE_DEVNET, BAD_NONCE, 0, 5),
      /nonce must be 32 bytes/,
    ],
    [
      'findAssetTransferNear: cap',
      (client) => findAssetTransferNear(client, USDC_BASE_DEVNET, 0, 0),
      /search cap must be a whole number/,
    ],
    [
      'readEip3009Legs: hash',
      (client) => readEip3009Legs(client, BAD_HASH, LEG_OPTIONS),
      /Not a transaction hash/,
    ],
    [
      'readEip3009Legs: nonce',
      (client) => readEip3009Legs(client, HASH, { ...LEG_OPTIONS, nonce: BAD_NONCE }),
      /nonce must be 32 bytes/,
    ],
    [
      'readEip3009Legs: payee',
      (client) => readEip3009Legs(client, HASH, { ...LEG_OPTIONS, to: BAD_ADDRESS }),
      /to is not an EVM address/,
    ],
    [
      'readEip3009Legs: minimum',
      (client) => readEip3009Legs(client, HASH, { ...LEG_OPTIONS, minValue: 0n }),
      /minimum of at least 1 subunit/,
    ],
    [
      'readAuthorizationBinding: tx hash',
      (client) =>
        readAuthorizationBinding(client, BASE_SEPOLIA, USDC_BASE_DEVNET, {
          ...HIT,
          txHash: BAD_HASH,
        }),
      /Not a transaction hash/,
    ],
    [
      'readAuthorizationBinding: block hash',
      (client) =>
        readAuthorizationBinding(client, BASE_SEPOLIA, USDC_BASE_DEVNET, {
          ...HIT,
          blockHash: BAD_HASH,
        }),
      /Not a block hash/,
    ],
    [
      'readAuthorizationBinding: from',
      (client) =>
        readAuthorizationBinding(client, BASE_SEPOLIA, USDC_BASE_DEVNET, {
          ...HIT,
          from: BAD_ADDRESS,
        }),
      /from is not an EVM address/,
    ],
    [
      'readAuthorizationBinding: to',
      (client) =>
        readAuthorizationBinding(client, BASE_SEPOLIA, USDC_BASE_DEVNET, {
          ...HIT,
          to: BAD_ADDRESS,
        }),
      /to is not an EVM address/,
    ],
    [
      'readEip3009Preflight: payer',
      (client) => readEip3009Preflight(client, BASE_SEPOLIA, USDC_BASE_DEVNET, BAD_ADDRESS, PAYEE),
      /payer is not an EVM address/,
    ],
    [
      'readEip3009Preflight: payee',
      (client) => readEip3009Preflight(client, BASE_SEPOLIA, USDC_BASE_DEVNET, PAYER, BAD_ADDRESS),
      /payee is not an EVM address/,
    ],
    [
      'estimate: payer',
      (client) => estimateTransferWithAuthorization(client, BASE_SEPOLIA, BAD_ADDRESS, '0x'),
      /payer is not an EVM address/,
    ],
    [
      'estimate: calldata',
      (client) => estimateTransferWithAuthorization(client, BASE_SEPOLIA, PAYER, 'not hex'),
      /calldata is not hex/,
    ],
    [
      'readL1Fee: calldata',
      (client) => readL1Fee(client, BASE_SEPOLIA, 'not hex'),
      /calldata is not hex/,
    ],
  ];

  for (const [label, call, message] of CASES) {
    it(label, async () => {
      const { client, calls } = scripted({});
      const answer = async (): Promise<unknown> => call(client);
      await expect(answer()).rejects.toThrow(message);
      expect(calls).toHaveLength(0);
    });
  }
});

describe('a log with a topic that is not 32 bytes is no log at all', () => {
  const SHORT_TOPIC = '0x1234';
  /** Valid but for one extra short topic: dropping it would leave a well-formed log. */
  function withShortTopic(log: ReturnType<typeof logEntry>): ReturnType<typeof logEntry> {
    return { ...log, topics: [log.topics[0] ?? '', SHORT_TOPIC, ...log.topics.slice(1)] };
  }

  it('makes each log walker incomplete', async () => {
    const transfer = withShortTopic(transferLog(PAYER, PAYEE, 1_000_000n, { block: 3 }));
    const used = withShortTopic(usedLog(PAYER, NONCE, { block: 3 }));
    const canceled = withShortTopic(
      logEntry({ topics: [AUTHORIZATION_CANCELED_TOPIC, `0x${word(PAYER)}`, NONCE], block: 3 }),
    );
    expect(
      await listPayoutTransfers(
        scripted({ eth_getLogs: () => [transfer] }).client,
        USDC_BASE_DEVNET,
        PAYEE,
        0,
        5,
      ),
    ).toMatchObject({ complete: false });
    expect(
      await listAuthorizationsByNonce(
        scripted({ eth_getLogs: () => [used] }).client,
        USDC_BASE_DEVNET,
        NONCE,
        0,
        5,
      ),
    ).toMatchObject({ complete: false });
    expect(
      await readAuthorizationCanceled(
        scripted({ eth_getLogs: () => [canceled] }).client,
        USDC_BASE_DEVNET,
        PAYER,
        NONCE,
        0,
        5,
      ),
    ).toMatchObject({ state: 'unreadable' });
    expect(
      await findAssetTransferNear(
        scripted({ eth_getLogs: () => [transfer] }).client,
        USDC_BASE_DEVNET,
        3,
        1,
      ),
    ).toMatchObject({ state: 'unreadable' });
  });

  it('makes both receipt readers unreadable', async () => {
    const pair = [
      withShortTopic(usedLog(PAYER, NONCE, { logIndex: 4 })),
      transferLog(PAYER, PAYEE, 1_000_000n, { logIndex: 5 }),
    ];
    expect(
      await readEip3009Legs(receiptNode({ receipt: receiptOf(pair) }).client, HASH, LEG_OPTIONS),
    ).toEqual({ state: 'unreadable' });
    expect(
      await readAuthorizationBinding(
        receiptNode({ receipt: receiptOf(pair) }).client,
        BASE_SEPOLIA,
        USDC_BASE_DEVNET,
        {
          txHash: HASH,
          blockNumber: 100,
          blockHash: BLOCK_HASH,
          logIndex: 5,
          from: PAYER,
          to: PAYEE,
          value: 1_000_000n,
        },
      ),
    ).toEqual({ state: 'unreadable' });
  });
});
