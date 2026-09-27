import {
  type OrderMessage,
  buildOrderMessage,
  deriveOrderPaymentReference,
  unwrapOrderMessage,
  wrapOrderMessage,
  type UnwrappedOrderMessage,
} from '@elisym/commerce';
import {
  type PaymentRequestData,
  USDC_SOLANA_DEVNET,
  buildPaymentInstructions,
  composeSolanaPaymentRequest,
  getProtocolProgramId,
} from '@elisym/pay-core';
import {
  type Address,
  type Blockhash,
  type Rpc,
  type SolanaRpcApi,
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { type StoreIdentity, storeIdentity } from '../src/intake';
import { type LedgerState, emptyLedger } from '../src/ledger';
import { publishTerms } from '../src/terms';

export const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const PAYOUT = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
export const PAYER = address('9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz');
export const PRICE = 1_000_000n;
export const T0 = 1_790_000_000;
export const D = 'course-101';
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as Blockhash;

export function signatureOf(fill: number): string {
  return getBase58Decoder().decode(new Uint8Array(64).fill(fill));
}

export interface Key {
  secretKey: Uint8Array;
  pubkey: string;
}

export function key(): Key {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export interface World {
  store: Key;
  identity: StoreIdentity;
  state: LedgerState;
}

/** A store selling one product at `PRICE` in devnet USDC, published at `T0`. */
export function world(): World {
  const store = key();
  const state = emptyLedger();
  state.terms = publishTerms(
    [],
    { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
    T0,
  );
  return { store, identity: storeIdentity(store.pubkey, D, ['solana-devnet']), state };
}

/** A message from `sender` to `recipient`, wrapped and unwrapped as the store would read it. */
export function delivered(
  message: OrderMessage,
  sender: Key,
  recipient: Key,
  createdAt = T0 + 60,
): UnwrappedOrderMessage {
  const wrapped = wrapOrderMessage(
    buildOrderMessage(message, createdAt),
    sender.secretKey,
    recipient.pubkey,
  );
  const unwrapped = unwrapOrderMessage(wrapped.recipientWrap, recipient.secretKey);
  if (unwrapped === undefined) {
    throw new Error('the fixture wrap did not open');
  }
  return unwrapped;
}

export function orderFrom(
  buyer: Key,
  store: Key,
  orderId: string,
  product = `30402:${store.pubkey}:${D}`,
) {
  return delivered(
    {
      type: 'order',
      storePubkey: store.pubkey,
      orderId,
      items: [{ product, quantity: 1 }],
      total: { amount: '1', currency: 'USD' },
    },
    buyer,
    store,
  );
}

export function referenceFor(store: Key, buyer: Key, orderId: string): string {
  return deriveOrderPaymentReference({
    storePubkey: store.pubkey,
    buyerPubkey: buyer.pubkey,
    orderId,
  }).solana;
}

/** The request the buyer's widget composes for an order. */
export function requestFor(reference: string, amount = PRICE): PaymentRequestData {
  return composeSolanaPaymentRequest({
    recipient: PAYOUT,
    amount,
    asset: USDC_SOLANA_DEVNET,
    network: 'devnet',
    reference,
    createdAt: T0,
  });
}

/** The json-encoded view an RPC gives of the widget's payment for `request`, landed at `blockTime`. */
export async function landedPayment(
  request: PaymentRequestData,
  options: { blockTime?: number | null; received?: bigint; payer?: Address; payee?: string } = {},
): Promise<Record<string, unknown>> {
  const payer = options.payer ?? PAYER;
  const instructions = await buildPaymentInstructions(request, createNoopSigner(payer), {
    programId: getProtocolProgramId('devnet'),
  });
  const compiled = compileTransactionMessage(
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(payer, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
          draft,
        ),
      (draft) =>
        appendTransactionMessageInstructions(
          // pay-core types its instructions loosely; the same cast its own tests use.
          instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
          draft,
        ),
    ),
  );
  if (compiled.version !== 0) {
    throw new Error('unexpected version');
  }
  const base58 = getBase58Decoder();
  const received = options.received ?? BigInt(request.amount);
  return {
    slot: 42n,
    blockTime: options.blockTime === undefined ? T0 + 120 : options.blockTime,
    transaction: {
      message: {
        accountKeys: compiled.staticAccounts.map(String),
        header: {
          numRequiredSignatures: compiled.header.numSignerAccounts,
          numReadonlySignedAccounts: compiled.header.numReadonlySignerAccounts,
          numReadonlyUnsignedAccounts: compiled.header.numReadonlyNonSignerAccounts,
        },
        instructions: compiled.instructions.map((instruction) => ({
          programIdIndex: instruction.programAddressIndex,
          accounts: instruction.accountIndices ?? [],
          data: base58.decode(instruction.data ?? new Uint8Array()),
        })),
      },
    },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: options.payee ?? request.recipient,
          uiTokenAmount: { amount: '0' },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: options.payee ?? request.recipient,
          uiTokenAmount: { amount: received.toString() },
        },
      ],
    },
  };
}

export interface ChainLog {
  /** Signatures fetched with getTransaction, in order. */
  fetched: string[];
  /** Each listing: the address and its options. */
  listings: { address: string; options: Record<string, unknown> }[];
}

/**
 * An RPC holding `transactions` by signature, and listing `listed` - newest
 * first - only for `account` (the payout's receiving account).
 */
export function chain(
  transactions: Record<string, unknown>,
  listed: string[] = [],
  options: {
    failing?: boolean;
    /** The first getTransaction fails, the rest answer. */
    failingOnce?: boolean;
    account?: string;
    fullPages?: boolean;
    /** Block time of each listed signature (default T0 + 120). */
    listedAt?: Record<string, number>;
  } = {},
): { rpc: Rpc<SolanaRpcApi>; log: ChainLog } {
  const log: ChainLog = { fetched: [], listings: [] };
  const rpc = {
    getTransaction: (signature: string) => ({
      send: async () => {
        log.fetched.push(signature);
        if (
          options.failing === true ||
          (options.failingOnce === true && log.fetched.length === 1)
        ) {
          throw new Error('node down');
        }
        return transactions[signature] ?? null;
      },
    }),
    getSignaturesForAddress: (listedAddress: string, listingOptions: Record<string, unknown>) => ({
      send: async () => {
        log.listings.push({ address: listedAddress, options: listingOptions });
        if (options.account !== undefined && listedAddress !== options.account) {
          return [];
        }
        const rows = listed.map((signature) => ({
          signature,
          err: null,
          blockTime: options.listedAt?.[signature] ?? T0 + 120,
          slot: 42n,
        }));
        // A spammed account: every page is full, so the page cap cuts the walk short.
        return options.fullPages === true
          ? Array.from(
              { length: 1000 },
              (_, index) => rows[index % Math.max(rows.length, 1)] ?? rows[0],
            )
          : rows;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, log };
}
