import { eip191Hash, parseCaip19, paytoProofMessage } from '@elisym/commerce';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58, hex } from '@scure/base';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { OwnerKey } from '../../src/cloud/lib/owner-key';
import {
  type PayoutRow,
  payoutAddress,
  payoutAssets,
  payoutRows,
  signOwnerEvents,
} from '../../src/cloud/lib/payouts';
import {
  type EvmProvider,
  type SolanaProvider,
  WalletRefused,
  injectedProviders,
  proveWithWallet,
} from '../../src/cloud/lib/wallet';

const NOW = Math.floor(Date.now() / 1000);
const STORE = '1'.repeat(64);
const USDC_SOLANA_MAINNET =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ALL_RAILS = new Set(['solana', 'tempo', 'ethereum', 'arbitrum', 'base']);
const ALLOWED: ReadonlySet<string> = new Set(
  payoutAssets('mainnet', ALL_RAILS).map((asset) => asset.caip19),
);
const UTF8 = new TextEncoder();

function solanaWallet() {
  const secret = ed25519.utils.randomSecretKey();
  return { secret, address: base58.encode(ed25519.getPublicKey(secret)) };
}

function evmWallet() {
  const secret = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(secret, false).slice(1);
  return { secret, address: `0x${hex.encode(keccak_256(publicKey).slice(-20))}` };
}

/** `personal_sign` as a wallet answers it: r || s || v hex. */
function personalSign(secret: Uint8Array, message: Uint8Array): string {
  const signature = secp256k1.sign(eip191Hash(message), secret, {
    prehash: false,
    format: 'recovered',
  });
  const recovery = signature[0] ?? 0;
  return `0x${hex.encode(signature.slice(1))}${(27 + recovery).toString(16)}`;
}

function solanaProof(owner: OwnerKey, caip19: string, secret: Uint8Array): string {
  return base58.encode(ed25519.sign(UTF8.encode(paytoProofMessage(owner.pubkey, caip19)), secret));
}

/** The promise is refused with a WalletRefused saying `text` (the class tells it from an unexpected failure). */
async function refusedWith(promise: Promise<unknown>, text: string) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WalletRefused);
  expect(error instanceof Error ? error.message : '').toContain(text);
}

const BASE_MAINNET = () =>
  payoutAssets('mainnet', ALL_RAILS).find((asset) => asset.label === 'USDC on Base')?.caip19 ?? '';

describe('the payout assets of a store', () => {
  it("are the registry coins of the store's network, each a CAIP-19 commerce parses; never native coins", () => {
    for (const network of ['mainnet', 'devnet'] as const) {
      const assets = payoutAssets(network, ALL_RAILS);
      expect(assets.length, network).toBeGreaterThan(3);
      for (const asset of assets) {
        const parsed = parseCaip19(asset.caip19);
        expect(parsed?.chain.network, asset.caip19).toBe(network);
        expect(parsed?.chain.family, asset.caip19).toBe(asset.family);
      }
    }
    const mainnet = payoutAssets('mainnet', ALL_RAILS);
    expect(mainnet.find((asset) => asset.caip19 === USDC_SOLANA_MAINNET)?.label).toBe(
      'USDC on Solana',
    );
    expect(mainnet.map((asset) => asset.label)).toContain('USDC on Base');
    expect(payoutAssets('devnet', ALL_RAILS).map((asset) => asset.caip19)).not.toContain(
      USDC_SOLANA_MAINNET,
    );
  });

  it('a testnet is named as one', () => {
    const labels = payoutAssets('devnet', ALL_RAILS).map((asset) => asset.label);
    expect(labels).toContain('USDC on Solana devnet');
    expect(labels).toContain('USDC on Base Sepolia');
    expect(labels.some((label) => label.endsWith(' on Base'))).toBe(false);
  });

  it('only on the rails the store has on', () => {
    const solanaOnly = payoutAssets('mainnet', new Set(['solana']));
    expect(solanaOnly.length).toBeGreaterThan(0);
    expect(solanaOnly.every((asset) => asset.family === 'solana')).toBe(true);
    const baseOnly = payoutAssets('mainnet', new Set(['base']));
    expect(baseOnly.map((asset) => asset.label)).toEqual(['USDC on Base']);
    expect(payoutAssets('mainnet', new Set())).toEqual([]);
  });
});

describe("the rows of the owner's list", () => {
  it('kept as parsePayto reads them: proved or unproved; anything else dropped, one address per asset', () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const another = solanaWallet();
    const good = solanaProof(owner, USDC_SOLANA_MAINNET, wallet.secret);
    const base = BASE_MAINNET();
    const evm = evmWallet();
    const list = owner.sign({
      kind: 10133,
      created_at: NOW,
      tags: [
        ['accept', USDC_SOLANA_MAINNET, wallet.address, good],
        ['other', 'x'],
        ['accept', base, evm.address.toUpperCase().replace('0X', '0x')],
        ['accept', base, evm.address, ''],
        ['accept', USDC_SOLANA_MAINNET, another.address, good],
        ['accept', 'solana:unknown/token:x', wallet.address],
        ['accept', USDC_SOLANA_MAINNET, 'not-an-address'],
      ],
      content: '',
    });
    expect(payoutRows(list, ALLOWED)).toEqual({
      rows: [
        { caip19: USDC_SOLANA_MAINNET, address: wallet.address, signature: good },
        { caip19: base, address: evm.address },
      ],
      dropped: 4,
    });
    expect(payoutRows(undefined, ALLOWED)).toEqual({ rows: [], dropped: 0 });
  });

  it('one address per asset, the first, even when a second one is proved too; an empty proof kept as none', () => {
    const owner = OwnerKey.create();
    const first = solanaWallet();
    const second = solanaWallet();
    const evm = evmWallet();
    const list = owner.sign({
      kind: 10133,
      created_at: NOW,
      tags: [
        [
          'accept',
          USDC_SOLANA_MAINNET,
          first.address,
          solanaProof(owner, USDC_SOLANA_MAINNET, first.secret),
        ],
        ['accept', BASE_MAINNET(), evm.address, ''],
        // Not next to the first: one address per asset across the whole list.
        [
          'accept',
          USDC_SOLANA_MAINNET,
          second.address,
          solanaProof(owner, USDC_SOLANA_MAINNET, second.secret),
        ],
      ],
      content: '',
    });
    expect(payoutRows(list, ALLOWED)).toEqual({
      rows: [
        {
          caip19: USDC_SOLANA_MAINNET,
          address: first.address,
          signature: solanaProof(owner, USDC_SOLANA_MAINNET, first.secret),
        },
        { caip19: BASE_MAINNET(), address: evm.address },
      ],
      dropped: 1,
    });
  });

  it('the first entry of an asset with a bad address is dropped, not kept', () => {
    const owner = OwnerKey.create();
    const list = owner.sign({
      kind: 10133,
      created_at: NOW,
      tags: [['accept', USDC_SOLANA_MAINNET, 'not-an-address']],
      content: '',
    });
    expect(payoutRows(list, ALLOWED)).toEqual({ rows: [], dropped: 1 });
  });

  it('an entry on an asset this store does not take is dropped', () => {
    const owner = OwnerKey.create();
    const evm = evmWallet();
    const wallet = solanaWallet();
    const list = owner.sign({
      kind: 10133,
      created_at: NOW,
      tags: [
        ['accept', USDC_SOLANA_MAINNET, wallet.address],
        ['accept', BASE_MAINNET(), evm.address],
      ],
      content: '',
    });
    const solanaOnly = new Set(
      payoutAssets('mainnet', new Set(['solana'])).map((asset) => asset.caip19),
    );
    expect(payoutRows(list, solanaOnly)).toEqual({
      rows: [{ caip19: USDC_SOLANA_MAINNET, address: wallet.address }],
      dropped: 1,
    });
    // A store with no rail on takes none.
    expect(payoutRows(list, new Set())).toEqual({ rows: [], dropped: 2 });
  });

  it('a proof that does not verify drops its row', () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const list = owner.sign({
      kind: 10133,
      created_at: NOW,
      tags: [
        [
          'accept',
          USDC_SOLANA_MAINNET,
          wallet.address,
          solanaProof(owner, USDC_SOLANA_MAINNET, solanaWallet().secret),
        ],
      ],
      content: '',
    });
    expect(payoutRows(list, ALLOWED)).toEqual({ rows: [], dropped: 1 });
  });

  it('an address as the list carries it, or none', () => {
    const solana = solanaWallet();
    const evm = evmWallet();
    const base = BASE_MAINNET();
    expect(payoutAddress(USDC_SOLANA_MAINNET, ` ${solana.address} `)).toBe(solana.address);
    expect(payoutAddress(base, evm.address.toUpperCase().replace('0X', '0x'))).toBe(evm.address);
    for (const [caip19, address] of [
      [USDC_SOLANA_MAINNET, 'not-an-address'],
      [USDC_SOLANA_MAINNET, '1'.repeat(32)],
      [base, `0x${'0'.repeat(40)}`],
      [base, solana.address],
      ['solana:unknown/token:x', solana.address],
    ]) {
      expect(payoutAddress(caip19 ?? '', address ?? ''), `${caip19} ${address}`).toBeUndefined();
    }
  });
});

describe('the wallet proof', () => {
  it('a Solana wallet connects, then signs the proof message; the proof is checked before it is used', async () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const calls: string[] = [];
    const provider: SolanaProvider = {
      async connect() {
        calls.push('connect');
        return {};
      },
      async signMessage(message, display) {
        calls.push(`sign ${new TextDecoder().decode(message)} ${String(display)}`);
        return { signature: ed25519.sign(message, wallet.secret) };
      },
    };
    const proved = await proveWithWallet(
      { solana: provider, evm: undefined },
      { ownerPubkey: owner.pubkey, caip19: USDC_SOLANA_MAINNET, address: ` ${wallet.address} ` },
    );
    expect(calls).toEqual([
      'connect',
      `sign ${paytoProofMessage(owner.pubkey, USDC_SOLANA_MAINNET)} utf8`,
    ]);
    expect(proved).toEqual({
      address: wallet.address,
      signature: solanaProof(owner, USDC_SOLANA_MAINNET, wallet.secret),
    });
  });

  it('a wallet that answers the bare signature bytes is taken too', async () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const proved = await proveWithWallet(
      {
        solana: {
          connect: async () => ({}),
          signMessage: async (message) => ed25519.sign(message, wallet.secret),
        },
        evm: undefined,
      },
      { ownerPubkey: owner.pubkey, caip19: USDC_SOLANA_MAINNET, address: wallet.address },
    );
    expect(proved.signature).toBe(solanaProof(owner, USDC_SOLANA_MAINNET, wallet.secret));
  });

  it('a wallet holding another key proves nothing for this address', async () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const other = solanaWallet();
    await expect(
      proveWithWallet(
        {
          solana: {
            connect: async () => ({}),
            signMessage: async (message) => ed25519.sign(message, other.secret),
          },
          evm: undefined,
        },
        { ownerPubkey: owner.pubkey, caip19: USDC_SOLANA_MAINNET, address: wallet.address },
      ),
    ).rejects.toThrow('did not sign for this address');
  });

  it('an EVM wallet signs with personal_sign for the canonical address; a wrong signer is refused', async () => {
    const owner = OwnerKey.create();
    const wallet = evmWallet();
    const base = BASE_MAINNET();
    const calls: { method: string; params?: unknown[] }[] = [];
    const provider = (secret: Uint8Array): EvmProvider => ({
      async request(args) {
        calls.push(args);
        if (args.method === 'eth_requestAccounts') {
          return [wallet.address];
        }
        return personalSign(secret, UTF8.encode(paytoProofMessage(owner.pubkey, base)));
      },
    });
    const proved = await proveWithWallet(
      { solana: undefined, evm: provider(wallet.secret) },
      {
        ownerPubkey: owner.pubkey,
        caip19: base,
        address: wallet.address.toUpperCase().replace('0X', '0x'),
      },
    );
    expect(proved.address).toBe(wallet.address);
    expect(proved.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(calls).toEqual([
      { method: 'eth_requestAccounts' },
      {
        method: 'personal_sign',
        params: [
          `0x${hex.encode(UTF8.encode(paytoProofMessage(owner.pubkey, base)))}`,
          wallet.address,
        ],
      },
    ]);
    await expect(
      proveWithWallet(
        { solana: undefined, evm: provider(evmWallet().secret) },
        { ownerPubkey: owner.pubkey, caip19: base, address: wallet.address },
      ),
    ).rejects.toThrow('did not sign for this address');
  });

  it("a wallet's own refusal is the merchant's words: declined, or anything else", async () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const input = {
      ownerPubkey: owner.pubkey,
      caip19: USDC_SOLANA_MAINNET,
      address: wallet.address,
    };
    const failing = (error: unknown): SolanaProvider => ({
      connect: async () => ({}),
      signMessage: async () => {
        throw error;
      },
    });
    await expect(
      proveWithWallet(
        { solana: failing({ code: 4001, message: 'User rejected' }), evm: undefined },
        input,
      ),
    ).rejects.toThrow('You declined in the wallet');
    await expect(
      proveWithWallet({ solana: failing('a bare string'), evm: undefined }, input),
    ).rejects.toThrow(WalletRefused);
    const base = BASE_MAINNET();
    const evm = evmWallet();
    await expect(
      proveWithWallet(
        {
          solana: undefined,
          evm: {
            request: async () => {
              throw { code: 4100, message: 'Unauthorized' };
            },
          },
        },
        { ownerPubkey: owner.pubkey, caip19: base, address: evm.address },
      ),
    ).rejects.toThrow('connect the account that holds this address');
    await expect(
      proveWithWallet(
        {
          solana: {
            connect: async () => {
              throw new Error('locked');
            },
            signMessage: async () => ({}),
          },
          evm: undefined,
        },
        input,
      ),
    ).rejects.toThrow(WalletRefused);
  });

  it('declining personal_sign itself is said as declined', async () => {
    const owner = OwnerKey.create();
    const evm = evmWallet();
    await expect(
      proveWithWallet(
        {
          solana: undefined,
          evm: {
            async request(args) {
              if (args.method === 'eth_requestAccounts') {
                return [evm.address];
              }
              throw { code: 4001, message: 'User rejected the request.' };
            },
          },
        },
        { ownerPubkey: owner.pubkey, caip19: BASE_MAINNET(), address: evm.address },
      ),
    ).rejects.toThrow('You declined in the wallet');
  });

  it('no wallet of that family, an unknown asset, a bad address, or an answer that is no signature: refused', async () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const input = {
      ownerPubkey: owner.pubkey,
      caip19: USDC_SOLANA_MAINNET,
      address: wallet.address,
    };
    await refusedWith(
      proveWithWallet({ solana: undefined, evm: undefined }, input),
      'No Solana wallet',
    );
    await refusedWith(
      proveWithWallet(
        { solana: undefined, evm: undefined },
        { ...input, caip19: 'eip155:8453/erc20:0x00' },
      ),
      'not one a payout takes',
    );
    await refusedWith(
      proveWithWallet({ solana: undefined, evm: undefined }, { ...input, address: 'nope' }),
      'not an address on this chain',
    );
    await refusedWith(
      proveWithWallet(
        { solana: undefined, evm: undefined },
        { ...input, caip19: BASE_MAINNET(), address: evmWallet().address },
      ),
      'No Ethereum wallet',
    );
    await expect(
      proveWithWallet(
        {
          solana: {
            connect: async () => ({}),
            signMessage: async () => ({ signature: 'not bytes' }),
          },
          evm: undefined,
        },
        input,
      ),
    ).rejects.toThrow(WalletRefused);
  });
});

describe("the page's injected providers", () => {
  it("are found as the page holds them, Phantom's first; anything else is none", () => {
    const solana: SolanaProvider = { connect: async () => ({}), signMessage: async () => ({}) };
    const phantom: SolanaProvider = { connect: async () => ({}), signMessage: async () => ({}) };
    const evm: EvmProvider = { request: async () => null };
    expect(injectedProviders({ solana, ethereum: evm })).toEqual({ solana, evm });
    expect(injectedProviders({ solana, phantom: { solana: phantom } }).solana).toBe(phantom);
    expect(injectedProviders({ solana: { connect: async () => ({}) }, ethereum: {} })).toEqual({
      solana: undefined,
      evm: undefined,
    });
    expect(injectedProviders({ solana: { signMessage: async () => ({}) } }).solana).toBeUndefined();
    expect(injectedProviders(undefined)).toEqual({ solana: undefined, evm: undefined });
  });

  it('a Phantom slot that is no usable provider falls back to window.solana', () => {
    const solana: SolanaProvider = { connect: async () => ({}), signMessage: async () => ({}) };
    expect(
      injectedProviders({ phantom: { solana: { connect: async () => ({}) } }, solana }).solana,
    ).toBe(solana);
  });

  it('class instances and non-enumerable providers count; a throwing getter beside them does not break the read', () => {
    class Solana {
      async connect() {
        return {};
      }
      async signMessage() {
        return {};
      }
    }
    class Ethereum {
      async request() {
        return null;
      }
    }
    const solana = new Solana();
    const view = {};
    Object.defineProperty(view, 'ethereum', { value: new Ethereum() });
    Object.defineProperty(view, 'solana', { value: solana, enumerable: true });
    Object.defineProperty(view, 'localStorage', {
      enumerable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    Object.defineProperty(view, 'phantom', {
      get() {
        throw new Error('blocked');
      },
    });
    const found = injectedProviders(view);
    expect(found.solana).toBe(solana);
    expect(found.evm).toBeInstanceOf(Ethereum);
  });
});

describe('the owner events signed for the cloud', () => {
  it('a payout list of the rows and a hosted AUTH with no expiry, at the date given', () => {
    const owner = OwnerKey.create();
    const wallet = solanaWallet();
    const evm = evmWallet();
    const signature = solanaProof(owner, USDC_SOLANA_MAINNET, wallet.secret);
    // A proved row, and an unproved one kept from the owner's own list.
    const rows: PayoutRow[] = [
      { caip19: USDC_SOLANA_MAINNET, address: wallet.address, signature },
      { caip19: BASE_MAINNET(), address: evm.address },
    ];
    const events = signOwnerEvents({
      signer: owner,
      storePubkey: STORE,
      operator: 'cloud.example',
      rows,
      createdAt: NOW - 5,
    });
    expect(verifyEvent(events.payoutList)).toBe(true);
    expect(verifyEvent(events.auth)).toBe(true);
    expect(events.payoutList.created_at).toBe(NOW - 5);
    expect(events.auth.created_at).toBe(NOW - 5);
    expect(events.auth.tags).toContainEqual(['mode', 'hosted', 'cloud.example']);
    expect(events.auth.tags.some((tag) => tag[0] === 'expiration')).toBe(false);
    expect(payoutRows(events.payoutList, ALLOWED)).toEqual({ rows, dropped: 0 });
    // That cloud-api takes them is a contract test in the cloud repo.
  });
});
