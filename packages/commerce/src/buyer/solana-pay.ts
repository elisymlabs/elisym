import {
  type Asset,
  type DirectInstruction,
  type Network,
  type PaymentRequestData,
  boundTransferAmount,
  buildPaymentInstructions,
  composeSolanaPaymentRequest,
  directInstructionsFromCompiledMessage,
  estimatePriorityFeeMicroLamports,
  estimateSolFeeLamports,
  getProtocolProgramId,
  parsePaymentRequest,
  verifyDirectSolanaPayment,
} from '@elisym/pay-core';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import {
  type Base64EncodedWireTransaction,
  type Signature,
  type Rpc,
  type SolanaRpcApi,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  isAddress,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit';
import { isOfferPayout, parseCaip19 } from '../index';
import {
  MERCHANT_CATCH_UP_SECS,
  PAYMENT_SCAN_MARGIN_SECS,
  PAY_CUTOFF_SECS,
  SOLANA_COMPUTE_UNIT_LIMIT,
  STORE_WRITE_ATTEMPTS,
} from './constants';
import { nowSecs } from './events';
import { type LoadedOffer, isSnapshotStale } from './offer';
import { type OrderDeps, sendReceipt } from './order-flow';
import { type OrderRecord, type PaymentMarker, isTerminal } from './order-record';
import type { OrderStore, StoreWrite } from './order-store';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;
type SolanaMarker = Extract<PaymentMarker, { rail: 'solana' }>;

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const BASE_FEE_LAMPORTS = 5000n;
/** One page of `getSignaturesForAddress` (the RPC's maximum) and at most this many pages. */
const SIGNATURE_PAGE_LIMIT = 1000;
const MAX_SIGNATURE_PAGES = 10;
/**
 * Blocks past the last valid height before "none" is acted on: an RPC's address
 * index and transaction store are written after the bank, and a transaction that
 * landed in the last blocks of the lifetime must have time to show there.
 */
const EXPIRY_SETTLE_BLOCKS = 32n;
/** System `AdvanceNonceAccount`: a durable-nonce transaction, which never expires. */
const ADVANCE_NONCE_DISCRIMINATOR = 4;
/** Signatures under one reference the widget checks at most; past it the answer is "unsure". */
const MAX_REFERENCE_CANDIDATES = 100;
/** Verdicts that say nothing final about a signature: ask again later. */
const UNSURE_VERDICTS = ['rpc_error', 'unreadable', 'not_found', 'bad_request'] as const;

/**
 * A wallet account offering `solana:signTransaction`. The wallet signs the wire
 * transaction the widget built and returns it; the widget sends it itself.
 */
export interface SolanaWallet {
  address: string;
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}

/**
 * What one payment attempt may spend, as the caller's spend limits count it:
 * the coin's amount (for a token), and the SOL that leaves the payer's wallet
 * (the fee, the payee's token-account rent when missing, `increment_stats`'
 * rent on a new asset, and the amount itself for native SOL). The payer's own
 * rent floor is only kept, never spent, so it is not counted.
 */
export interface PaymentCosts {
  asset: Asset;
  /** Subunits of `asset` when it is a token; 0 for native SOL (counted in `lamports`). */
  tokenAmount: bigint;
  lamports: bigint;
  /**
   * The network fee inside `lamports`: the one part an attempt that never paid
   * may still have spent (a transaction that landed and failed).
   */
  feeLamports: bigint;
}

export interface SolanaPayDeps extends OrderDeps {
  /** The widget's own Solana RPC. */
  rpc: Rpc<SolanaRpcApi>;
  /** The device clock (seconds); the receipt's date and the marker's `setAt`. */
  now?: () => number;
  newAttemptId?: () => string;
  /**
   * Whether `rpc` can prove an attempt over: a full-history endpoint whose
   * "no payment" can be trusted. Without it (`false`) the watch never answers
   * `over`, so nothing is retried or ended on an answer that could be wrong.
   * The widget always has one (true, the default).
   */
  canProveOver?: boolean;
  /**
   * Called once an attempt's costs are known and before its marker is written;
   * a throw refuses the payment with `spend_limit` before anything is recorded.
   */
  reserve?: (costs: PaymentCosts, attemptId: string) => void;
  /** Called when the attempt `attemptId` was refused after `reserve`, before any broadcast. */
  release?: (attemptId: string) => void;
}

export interface PayInput {
  /** A FRESH verified offer (at most two minutes old): the payout and price are checked against it. */
  fresh: ReadyOffer;
  /** Chain time read just before (seconds). */
  chainTime: number;
}

export type SolanaPayRefusal =
  /** The record cannot take a payment now (state, no request, the store closed it). */
  | 'not_payable'
  /** The offer snapshot is older than two minutes: verify again. */
  | 'stale_offer'
  /** The store no longer offers this payout at this price: end this order and start a new one. */
  | 'offer_changed'
  /** Too close to the end of the merchant's catch-up: a new order instead. */
  | 'too_late'
  /** The payer is the payout address itself (a transfer to oneself pays nothing). */
  | 'self_payment'
  | 'insufficient_token'
  | 'insufficient_sol'
  /** A chain read failed; nothing was requested. */
  | 'rpc_error'
  /** Another order for this product holds a live payment. */
  | 'exclusion'
  /** The record changed meanwhile; read it again. */
  | 'conflict'
  /** The wallet did not sign. The attempt stays live until its blockhash expires. */
  | 'wallet_failed'
  /** The wallet returned a transaction the widget does not send (below). Same wait. */
  | 'wallet_unsupported'
  /** A retry before the last attempt provably ended. */
  | 'still_waiting'
  | 'already_paid'
  /** The caller's spend limit refused the attempt's costs (`reserve` threw). Nothing was recorded. */
  | 'spend_limit'
  /**
   * A Tempo order of this product ended with its wallet prompt still open:
   * the buyer confirms the warning (`confirmedOverIds`) before this request.
   */
  | 'needs_confirmation';

export type SolanaPayResult =
  | { ok: true; record: OrderRecord; signature: string }
  | {
      ok: false;
      reason: SolanaPayRefusal;
      record?: OrderRecord;
      /** For `exclusion`: the order holding it. */
      holder?: string;
      /** For `needs_confirmation`: the ended orders to confirm. */
      unconfirmed?: string[];
      /** For `insufficient_*`: what the payment needs and what the payer has, in subunits / lamports. */
      needed?: bigint;
      available?: bigint;
      /** For `wallet_unsupported`: what was wrong with the returned transaction. */
      detail?: SignedRefusal;
    };

/** The request stored on the record, as the schema reads it. */
export function storedSolanaRequest(record: OrderRecord): PaymentRequestData | undefined {
  if (record.paymentRequest === undefined) {
    return undefined;
  }
  const parsed = parsePaymentRequest(record.paymentRequest);
  return parsed.ok ? parsed.data : undefined;
}

function solanaAssetOf(record: OrderRecord): { asset: Asset; network: Network } | undefined {
  const caip19 = parseCaip19(record.payout.caip19);
  if (caip19 === undefined || caip19.chain.family !== 'solana') {
    return undefined;
  }
  return { asset: caip19.asset, network: caip19.chain.network };
}

/**
 * Compose the order's payment request once, right after the order was
 * acknowledged, from the order's own snapshot; resume and every verdict use this
 * stored request, never a recomposed one.
 */
export async function composeOrderPayment(
  record: OrderRecord,
  store: OrderStore,
): Promise<StoreWrite> {
  if (record.paymentRequest !== undefined) {
    return { ok: true, record };
  }
  const coin = solanaAssetOf(record);
  if (coin === undefined) {
    return { ok: false, reason: 'not_ready' };
  }
  let request: PaymentRequestData;
  try {
    request = composeSolanaPaymentRequest({
      recipient: record.payout.address,
      amount: BigInt(record.amount),
      asset: coin.asset,
      network: coin.network,
      reference: record.reference,
      createdAt: record.createdAt,
    });
  } catch {
    return { ok: false, reason: 'not_ready' };
  }
  const written = await store.update(record.orderId, record.version, {
    paymentRequest: JSON.stringify(request),
  });
  if (!written.ok && written.reason === 'conflict') {
    const current = await store.get(record.orderId);
    if (current?.paymentRequest !== undefined) {
      return { ok: true, record: current };
    }
  }
  return written;
}

/** What the payer holds and what the payment needs besides the fee itself. */
interface Funds {
  /** The payer's SOL, read before the marker. */
  lamports: bigint;
  /**
   * Everything but the transaction fee the payer's SOL must cover: the payee's
   * token-account rent when missing, `increment_stats`' rent on a new asset, the
   * payer's own rent floor, and the amount itself for native SOL.
   */
  otherLamports: bigint;
  /** The compute-unit price the widget asks (micro-lamports), for the payment's own accounts. */
  priceMicroLamports: bigint;
  /** What the attempt spends, for the caller's spend limits. */
  costs: PaymentCosts;
}

type Checked =
  | { ok: true; request: PaymentRequestData; asset: Asset; network: Network; funds: Funds }
  | Extract<SolanaPayResult, { ok: false }>;

/** The stored request pays what the record says: the payout, the reference, the coin. */
function requestMatches(
  request: PaymentRequestData,
  record: OrderRecord,
  coin: { asset: Asset; network: Network },
): boolean {
  return (
    request.recipient === record.payout.address &&
    request.reference === record.reference &&
    BigInt(request.amount) === BigInt(record.amount) &&
    (request.network ?? 'devnet') === coin.network &&
    request.asset?.mint === coin.asset.mint &&
    (request.fee_amount ?? 0) === 0 &&
    request.fee_address === undefined
  );
}

/**
 * Every check that runs BEFORE the marker: nothing was requested if one fails.
 * The fresh offer must still hold this payout at exactly the stored amount (a
 * higher price cannot be accepted, a lower one would overpay).
 */
export async function checkBeforePaying(
  record: OrderRecord,
  payer: string,
  input: PayInput,
  deps: Pick<SolanaPayDeps, 'rpc' | 'now'>,
): Promise<Checked> {
  const request = storedSolanaRequest(record);
  const coin = solanaAssetOf(record);
  if (
    request === undefined ||
    coin === undefined ||
    !isAddress(payer) ||
    !requestMatches(request, record, coin)
  ) {
    return { ok: false, reason: 'not_payable', record };
  }
  if (isSnapshotStale(input.fresh.snapshotAt, (deps.now ?? nowSecs)())) {
    return { ok: false, reason: 'stale_offer', record };
  }
  const match = input.fresh.payouts.find(
    (payout) =>
      payout.target.caip19.id === record.payout.caip19 &&
      payout.target.address === record.payout.address,
  );
  if (
    input.fresh.productAddress !== record.productAddress ||
    !isOfferPayout(input.fresh.offer, record.payout.caip19, record.payout.address) ||
    match === undefined ||
    match.amount !== BigInt(record.amount)
  ) {
    return { ok: false, reason: 'offer_changed', record };
  }
  if (input.chainTime > record.createdAt + MERCHANT_CATCH_UP_SECS - PAY_CUTOFF_SECS) {
    return { ok: false, reason: 'too_late', record };
  }
  if (payer === record.payout.address) {
    return { ok: false, reason: 'self_payment', record };
  }
  const funds = await checkFunds(deps.rpc, request, payer, coin);
  if (!funds.ok) {
    return { ...funds, record };
  }
  return { ok: true, request, asset: coin.asset, network: coin.network, funds: funds.funds };
}

/** The payer's and the payee's accounts of the asset: what the payment write-locks. */
async function assetAccounts(
  payer: string,
  recipient: string,
  asset: Asset,
): Promise<{ payer: string; payee: string }> {
  if (asset.mint === undefined) {
    return { payer, payee: recipient };
  }
  const tokenProgram = address(asset.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);
  const mint = address(asset.mint);
  const [payerAccount] = await findAssociatedTokenPda({
    owner: address(payer),
    mint,
    tokenProgram,
  });
  const [payeeAccount] = await findAssociatedTokenPda({
    owner: address(recipient),
    mint,
    tokenProgram,
  });
  return { payer: payerAccount, payee: payeeAccount };
}

/** The payer's balance of the asset's token, 0 when it holds no token account. */
async function tokenBalance(rpc: Rpc<SolanaRpcApi>, account: string): Promise<bigint> {
  const info = await rpc
    .getAccountInfo(address(account), { commitment: 'confirmed', encoding: 'base64' })
    .send();
  if (info.value === null) {
    return 0n;
  }
  const balance = await rpc
    .getTokenAccountBalance(address(account), { commitment: 'confirmed' })
    .send();
  return BigInt(balance.value.amount);
}

/**
 * Whether the payer can pay: the asset for the amount, and SOL for the fees, for
 * creating the payee's token account when it is missing, and for its own rent
 * floor. Refused before the wallet opens - the widget says what is short. The
 * compute-unit price is read for the payment's own accounts (a price over no
 * accounts is the chain-wide floor, which a busy block leaves behind).
 */
async function checkFunds(
  rpc: Rpc<SolanaRpcApi>,
  request: PaymentRequestData,
  payer: string,
  coin: { asset: Asset; network: Network },
): Promise<{ ok: true; funds: Funds } | Extract<SolanaPayResult, { ok: false }>> {
  try {
    const amount = BigInt(request.amount);
    const accounts = await assetAccounts(payer, request.recipient, coin.asset);
    const priceMicroLamports = await estimatePriorityFeeMicroLamports(rpc, {
      network: coin.network,
      accounts: [address(accounts.payer), address(accounts.payee)],
    });
    const fees = await estimateSolFeeLamports(rpc, request, payer, coin.network, {
      computeUnitLimit: SOLANA_COMPUTE_UNIT_LIMIT,
      priorityFeeMicroLamports: priceMicroLamports,
    });
    const rentFloor = await rpc.getMinimumBalanceForRentExemption(0n).send();
    const lamports = (await rpc.getBalance(address(payer), { commitment: 'confirmed' }).send())
      .value;
    const otherLamports =
      fees.rentLamports +
      fees.assetStatsRentLamports +
      rentFloor +
      (coin.asset.mint === undefined ? amount : 0n);
    const feeLamports = fees.baseFeeLamports + fees.priorityFeeLamports;
    if (coin.asset.mint !== undefined) {
      const tokens = await tokenBalance(rpc, accounts.payer);
      if (tokens < amount) {
        return { ok: false, reason: 'insufficient_token', needed: amount, available: tokens };
      }
    }
    if (lamports < otherLamports + feeLamports) {
      return {
        ok: false,
        reason: 'insufficient_sol',
        needed: otherLamports + feeLamports,
        available: lamports,
      };
    }
    const costs: PaymentCosts = {
      asset: coin.asset,
      tokenAmount: coin.asset.mint === undefined ? 0n : amount,
      lamports:
        fees.rentLamports +
        fees.assetStatsRentLamports +
        feeLamports +
        (coin.asset.mint === undefined ? amount : 0n),
      feeLamports,
    };
    return { ok: true, funds: { lamports, otherLamports, priceMicroLamports, costs } };
  } catch {
    return { ok: false, reason: 'rpc_error' };
  }
}

interface Unsigned {
  bytes: Uint8Array;
  blockhash: string;
  lastValidBlockHeight: bigint;
  /** The slot the blockhash was read at. */
  slot: bigint;
}

/**
 * The payment transaction, unsigned: pay-core's instructions (the bound transfer
 * and `increment_stats`), the widget's own blockhash, a compute limit and price.
 * The blockhash and its last valid height are the attempt's lifetime.
 */
async function unsignedPayment(
  rpc: Rpc<SolanaRpcApi>,
  checked: Extract<Checked, { ok: true }>,
  payer: string,
): Promise<Unsigned> {
  const payerAddress = address(payer);
  const instructions = await buildPaymentInstructions(
    checked.request,
    createNoopSigner(payerAddress),
    { programId: getProtocolProgramId(checked.network) },
  );
  const { context, value: latest } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(payerAddress, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(latest, draft),
    (draft) => setTransactionMessageComputeUnitLimit(SOLANA_COMPUTE_UNIT_LIMIT, draft),
    (draft) => setTransactionMessageComputeUnitPrice(checked.funds.priceMicroLamports, draft),
    (draft) =>
      appendTransactionMessageInstructions(
        // pay-core types its instructions loosely; the same cast its own builder uses.
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        draft,
      ),
  );
  return {
    bytes: new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    slot: BigInt(context.slot),
  };
}

export type SignedRefusal =
  /** Not a transaction the widget can read. */
  | 'unreadable'
  /** Another blockhash, or a durable nonce (no expiry at all). */
  | 'lifetime_changed'
  /** Another fee payer than the wallet account. */
  | 'wrong_payer'
  /** A signature is missing or does not verify. */
  | 'unsigned'
  /** The bound transfer is gone or pays another amount. */
  | 'not_bound'
  /** A compute-budget setting twice: the runtime refuses the whole transaction. */
  | 'duplicate_compute_budget';

/**
 * The fee the transaction pays, from its own compute-budget instructions: the
 * signatures' base fee plus limit × price. Without a limit the runtime grants
 * 200 000 units per other instruction (at most 1.4 M). `undefined` when a
 * setting appears twice.
 */
function transactionFee(instructions: readonly DirectInstruction[], signatures: number) {
  let limit: bigint | undefined;
  let price = 0n;
  let limits = 0;
  let prices = 0;
  let others = 0;
  for (const instruction of instructions) {
    if (instruction.program !== COMPUTE_BUDGET_PROGRAM) {
      others += 1;
      continue;
    }
    const view = new DataView(
      instruction.data.buffer,
      instruction.data.byteOffset,
      instruction.data.byteLength,
    );
    if (instruction.data[0] === SET_COMPUTE_UNIT_LIMIT && instruction.data.length === 5) {
      limits += 1;
      limit = BigInt(view.getUint32(1, true));
    } else if (instruction.data[0] === SET_COMPUTE_UNIT_PRICE && instruction.data.length === 9) {
      prices += 1;
      price = view.getBigUint64(1, true);
    }
  }
  if (limits > 1 || prices > 1) {
    return undefined;
  }
  const units = limit ?? BigInt(Math.min(others * 200_000, 1_400_000));
  return BASE_FEE_LAMPORTS * BigInt(signatures) + (price * units + 999_999n) / 1_000_000n;
}

/**
 * What the widget sends of a transaction the wallet returned: only one whose
 * lifetime is exactly the attempt's blockhash (no durable nonce), paid by the
 * wallet account, fully signed, with each compute-budget setting at most once,
 * and whose bound transfer still pays exactly the stored amount - the same
 * binding the merchant and "found" judge. It also returns the fee the
 * transaction pays: a wallet may raise the price the widget set.
 */
export async function checkSignedTransaction(
  bytes: Uint8Array,
  expected: { payer: string; blockhash: string; request: PaymentRequestData; asset: Asset },
): Promise<
  | { ok: true; signature: string; wire: string; feeLamports: bigint }
  | { ok: false; reason: SignedRefusal }
> {
  let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>['decode']>;
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  let instructions: DirectInstruction[];
  try {
    transaction = getTransactionDecoder().decode(bytes);
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    instructions = directInstructionsFromCompiledMessage(message);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const first = instructions[0];
  const durableNonce =
    first !== undefined &&
    first.program === SYSTEM_PROGRAM &&
    first.data.length >= 4 &&
    new DataView(first.data.buffer, first.data.byteOffset, 4).getUint32(0, true) ===
      ADVANCE_NONCE_DISCRIMINATOR;
  if (message.lifetimeToken !== expected.blockhash || durableNonce) {
    return { ok: false, reason: 'lifetime_changed' };
  }
  if (String(message.staticAccounts[0]) !== expected.payer) {
    return { ok: false, reason: 'wrong_payer' };
  }
  const signatures = Object.entries(transaction.signatures);
  if (signatures.length === 0) {
    return { ok: false, reason: 'unsigned' };
  }
  for (const [signer, signature] of signatures) {
    let valid = false;
    try {
      valid =
        signature !== null &&
        (await verifySignature(
          await getPublicKeyFromAddress(address(signer)),
          signature,
          transaction.messageBytes,
        ));
    } catch {
      // An address that is no key (a PDA added as a signer) cannot have signed.
      valid = false;
    }
    if (!valid) {
      return { ok: false, reason: 'unsigned' };
    }
  }
  const payerSignature = transaction.signatures[address(expected.payer)] ?? null;
  const feeLamports = transactionFee(instructions, signatures.length);
  if (feeLamports === undefined) {
    return { ok: false, reason: 'duplicate_compute_budget' };
  }
  const bound = await boundTransferAmount(instructions, {
    reference: expected.request.reference,
    recipient: expected.request.recipient,
    asset: expected.asset,
  });
  if (payerSignature === null || bound !== BigInt(expected.request.amount)) {
    return { ok: false, reason: payerSignature === null ? 'unsigned' : 'not_bound' };
  }
  return {
    ok: true,
    signature: getBase58Decoder().decode(payerSignature),
    wire: getBase64Decoder().decode(bytes),
    feeLamports,
  };
}

/** Send the signed bytes; a failure here is judged by the chain later, never by this call. */
async function broadcast(rpc: Rpc<SolanaRpcApi>, wire: string): Promise<void> {
  try {
    await rpc
      .sendTransaction(wire as Base64EncodedWireTransaction, {
        encoding: 'base64',
        skipPreflight: true,
      })
      .send();
  } catch {
    // Rebroadcast while waiting; the reference pass decides.
  }
}

/**
 * Ask the wallet to sign the attempt `marker` (already set), check what it
 * returned, record the signature and the bytes BEFORE the first broadcast, send,
 * and send the receipt. Any failure leaves the marker: Wallet Standard has no
 * proving rejection, so the attempt stays live until its blockhash expires.
 */
async function signAndSend(
  record: OrderRecord,
  marker: SolanaMarker,
  unsigned: Unsigned,
  wallet: SolanaWallet,
  checked: Extract<Checked, { ok: true }>,
  deps: SolanaPayDeps,
): Promise<SolanaPayResult> {
  let signedBytes: Uint8Array;
  try {
    signedBytes = await wallet.signTransaction(unsigned.bytes);
  } catch {
    return { ok: false, reason: 'wallet_failed', record };
  }
  const signed = await checkSignedTransaction(signedBytes, {
    payer: wallet.address,
    blockhash: unsigned.blockhash,
    request: checked.request,
    asset: checked.asset,
  });
  if (!signed.ok) {
    return { ok: false, reason: 'wallet_unsupported', record, detail: signed.reason };
  }
  // A wallet may raise the price the widget set: a payer who cannot cover the fee
  // it signed would send a transaction that never lands.
  const needed = checked.funds.otherLamports + signed.feeLamports;
  if (checked.funds.lamports < needed) {
    deps.release?.(marker.attemptId);
    return {
      ok: false,
      reason: 'insufficient_sol',
      record,
      needed,
      available: checked.funds.lamports,
    };
  }
  // The wallet may take long: the attempt id, not the version the caller saw, is
  // what must still hold. A failed write means no broadcast.
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.marker?.attemptId !== marker.attemptId) {
      deps.release?.(marker.attemptId);
      return { ok: false, reason: 'conflict', record: current };
    }
    const written = await deps.store.updateMarker(
      current.orderId,
      current.version,
      marker.attemptId,
      { ...marker, signature: signed.signature, signedTransaction: signed.wire },
    );
    if (written.ok) {
      await broadcast(deps.rpc, signed.wire);
      const receipt = await sendReceipt(
        written.record,
        signed.signature,
        (deps.now ?? nowSecs)(),
        deps,
      );
      return {
        ok: true,
        record: receipt.ok ? receipt.record : written.record,
        signature: signed.signature,
      };
    }
    if (written.reason !== 'conflict') {
      deps.release?.(marker.attemptId);
      return { ok: false, reason: 'conflict', record: current };
    }
    current = await deps.store.get(record.orderId);
  }
  deps.release?.(marker.attemptId);
  return { ok: false, reason: 'conflict', ...(current === undefined ? {} : { record: current }) };
}

function storeRefusal(
  written: Extract<StoreWrite, { ok: false }>,
  record: OrderRecord,
): SolanaPayResult {
  if (written.reason === 'exclusion') {
    return {
      ok: false,
      reason: 'exclusion',
      record,
      ...(written.holder === undefined ? {} : { holder: written.holder }),
    };
  }
  if (written.reason === 'needs_confirmation') {
    return {
      ok: false,
      reason: 'needs_confirmation',
      record,
      unconfirmed: written.unconfirmed ?? [],
    };
  }
  return { ok: false, reason: written.reason === 'conflict' ? 'conflict' : 'not_payable', record };
}

/**
 * Run the write that records a new attempt; a throw gives the attempt's
 * reservation back (nothing was signed or sent on it) and is rethrown.
 */
async function withReleaseOnThrow<T>(
  attemptId: string,
  deps: SolanaPayDeps,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    deps.release?.(attemptId);
    throw error;
  }
}

/** Ask the caller's spend limits for the attempt's costs; `false` when refused. */
function reserveCosts(costs: PaymentCosts, attemptId: string, deps: SolanaPayDeps): boolean {
  if (deps.reserve === undefined) {
    return true;
  }
  try {
    deps.reserve(costs, attemptId);
    return true;
  } catch {
    return false;
  }
}

function newMarker(unsigned: Unsigned, deps: SolanaPayDeps): SolanaMarker {
  return {
    rail: 'solana',
    attemptId: (deps.newAttemptId ?? (() => crypto.randomUUID()))(),
    setAt: (deps.now ?? nowSecs)(),
    blockhash: unsigned.blockhash,
    lastValidBlockHeight: unsigned.lastValidBlockHeight.toString(),
    slot: unsigned.slot.toString(),
  };
}

/**
 * The first payment of an acknowledged order: checks, the transaction, then the
 * marker (test-and-set with the product's other orders) and only then the wallet.
 */
export async function payWithSolana(
  record: OrderRecord,
  wallet: SolanaWallet,
  input: PayInput,
  deps: SolanaPayDeps,
): Promise<SolanaPayResult> {
  if (record.state !== 'ordered' || record.marker !== undefined) {
    return { ok: false, reason: 'not_payable', record };
  }
  const checked = await checkBeforePaying(record, wallet.address, input, deps);
  if (!checked.ok) {
    return checked;
  }
  let unsigned: Unsigned;
  try {
    unsigned = await unsignedPayment(deps.rpc, checked, wallet.address);
  } catch {
    return { ok: false, reason: 'rpc_error', record };
  }
  const marker = newMarker(unsigned, deps);
  if (!reserveCosts(checked.funds.costs, marker.attemptId, deps)) {
    return { ok: false, reason: 'spend_limit', record };
  }
  const marked = await withReleaseOnThrow(marker.attemptId, deps, () =>
    deps.store.setMarker(record.orderId, record.version, marker, (deps.now ?? nowSecs)()),
  );
  if (!marked.ok) {
    deps.release?.(marker.attemptId);
    return storeRefusal(marked, record);
  }
  return signAndSend(marked.record, marker, unsigned, wallet, checked, deps);
}

export type SolanaWatch =
  /** The payment was found and recorded. */
  | { state: 'paid'; record: OrderRecord }
  /** The attempt may still land, or the chain could not be read in full: keep watching. */
  | { state: 'waiting'; record: OrderRecord }
  /** The attempt's blockhash expired at `finalized` and a full pass found no payment. */
  | { state: 'over'; record: OrderRecord }
  /**
   * The store delivered or refunded (a terminal record): its answer stands and
   * nothing is left to watch. Says nothing about which transaction paid.
   */
  | { state: 'closed'; record: OrderRecord };

type Search = { found: string } | 'none' | 'unsure';

/**
 * Every signature under the reference, newest first, paged until one is older
 * than `notBefore` - pay-core's walk, with `minContextSlot`: a load-balanced RPC
 * may answer from a node behind the one that reported the blockhash expired, and
 * such a node must refuse (unsure) rather than list without the payment.
 */
async function listReference(
  rpc: Rpc<SolanaRpcApi>,
  reference: string,
  notBefore: number,
  minContextSlot: bigint | undefined,
): Promise<{ signatures: { signature: string; failed: boolean }[]; complete: boolean }> {
  const signatures: { signature: string; failed: boolean }[] = [];
  let before: Signature | undefined;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const rows = await rpc
      .getSignaturesForAddress(address(reference), {
        limit: SIGNATURE_PAGE_LIMIT,
        commitment: 'confirmed',
        ...(minContextSlot === undefined ? {} : { minContextSlot }),
        ...(before === undefined ? {} : { before }),
      })
      .send();
    let reachedFloor = false;
    for (const row of rows) {
      signatures.push({ signature: row.signature, failed: row.err !== null });
      if (row.blockTime !== null && Number(row.blockTime) < notBefore) {
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

/**
 * Look for a payment of this order: the attempt's own signature, then every
 * signature under the reference. A failed transaction is not a payment;
 * anything unreadable makes the answer "unsure", never "none". The caller acts
 * on "none" only with `minContextSlot` (the finalized slot that proved the
 * blockhash expired): the listing is then complete up to that slot, so a
 * signature it does not hold, which the node does not serve either, never landed.
 */
async function searchPayment(
  record: OrderRecord,
  request: PaymentRequestData,
  rpc: Rpc<SolanaRpcApi>,
  minContextSlot: bigint | undefined,
): Promise<Search> {
  const own = record.marker?.rail === 'solana' ? record.marker.signature : undefined;
  const candidates: string[] = own === undefined ? [] : [own];
  const listed = new Set<string>();
  let unsure = false;
  try {
    const listing = await listReference(
      rpc,
      request.reference,
      record.createdAt - PAYMENT_SCAN_MARGIN_SECS,
      minContextSlot,
    );
    unsure = !listing.complete;
    for (const entry of listing.signatures) {
      listed.add(entry.signature);
      if (!entry.failed && !candidates.includes(entry.signature)) {
        candidates.push(entry.signature);
      }
    }
  } catch {
    unsure = true;
  }
  if (candidates.length > MAX_REFERENCE_CANDIDATES) {
    unsure = true;
  }
  for (const signature of candidates.slice(0, MAX_REFERENCE_CANDIDATES)) {
    let verdict: Awaited<ReturnType<typeof verifyDirectSolanaPayment>>;
    try {
      verdict = await verifyDirectSolanaPayment(rpc, request, signature);
    } catch {
      // A signature the node listed that cannot even be read: never proof of "none".
      unsure = true;
      continue;
    }
    if (verdict.verified) {
      return { found: signature };
    }
    if (!(UNSURE_VERDICTS as readonly string[]).includes(verdict.reason)) {
      continue;
    }
    // Not served and not listed: it has not landed - for the attempt's own
    // signature only once its status is unknown too, from the bank's recent
    // statuses and from history (an address index may lag the slot the node is at).
    // Only "none" after expiry is acted on, and that listing reads at least as far
    // as the expiry slot.
    if (
      verdict.reason === 'not_found' &&
      !listed.has(signature) &&
      (signature !== own ||
        minContextSlot === undefined ||
        !(await statusKnown(rpc, signature, minContextSlot)))
    ) {
      continue;
    }
    unsure = true;
  }
  return unsure ? 'unsure' : 'none';
}

/**
 * Whether the signature's status is known, with history: known when found, and
 * also when the answering node is behind `minContextSlot` (a load-balanced RPC
 * may send this read elsewhere) or the read fails - neither proves anything.
 */
async function statusKnown(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  minContextSlot: bigint,
): Promise<boolean> {
  try {
    const statuses = await rpc
      .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
      .send();
    const status = statuses.value[0];
    return (
      BigInt(statuses.context.slot) < minContextSlot || (status !== null && status !== undefined)
    );
  } catch {
    return true;
  }
}

/**
 * Record the payment found, with a receipt naming it unless one already went
 * out for it: the attempt's own receipt may have been lost (the tab closed
 * after the broadcast), and a payment that is not the attempt's own (another
 * device) needs its own - while the record still takes one.
 */
async function recordPaid(
  record: OrderRecord,
  signature: string,
  deps: SolanaPayDeps,
): Promise<OrderRecord> {
  let current: OrderRecord | undefined = record;
  const own = record.marker?.rail === 'solana' ? record.marker.signature : undefined;
  if (current.receiptWrap === undefined || (current.state === 'paying' && own !== signature)) {
    const receipt = await sendReceipt(current, signature, (deps.now ?? nowSecs)(), deps);
    if (receipt.ok) {
      current = receipt.record;
    }
  }
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.paidTx !== undefined) {
      return current;
    }
    const written = await deps.store.update(current.orderId, current.version, {
      state: 'paid',
      paidTx: signature,
    });
    if (written.ok) {
      return written.record;
    }
    if (written.reason !== 'conflict') {
      return current;
    }
    current = await deps.store.get(record.orderId);
  }
  return current ?? record;
}

/**
 * Whether the RPC's history reaches back to the attempt's slot (unknown counts as
 * no). `getFirstAvailableBlock` covers a node's long-term storage too, where
 * `minimumLedgerSlot` would name only its local ledger.
 */
async function ledgerReaches(rpc: Rpc<SolanaRpcApi>, slot: string | undefined): Promise<boolean> {
  if (slot === undefined) {
    return false;
  }
  try {
    return BigInt(await rpc.getFirstAvailableBlock().send()) <= BigInt(slot);
  } catch {
    return false;
  }
}

/**
 * One reconciliation step for a record with a Solana attempt: found -> paid;
 * otherwise the signed bytes are sent again while the blockhash can land, and
 * once it expired at `finalized` - read BEFORE the pass, together with its slot
 * (the pass reads at least that far), so a pass that finds nothing proves it -
 * a complete pass that finds nothing ends the attempt.
 */
export async function watchSolanaPayment(
  record: OrderRecord,
  deps: SolanaPayDeps,
): Promise<SolanaWatch> {
  // Delivered or refunded: the store has answered, nothing is left to watch (the
  // delivery can arrive before the widget itself found the payment).
  if (isTerminal(record)) {
    return { state: 'closed', record };
  }
  if (record.paidTx !== undefined) {
    // A receipt lost before the payment was recorded is sent now.
    if (record.receiptWrap === undefined) {
      const receipt = await sendReceipt(record, record.paidTx, (deps.now ?? nowSecs)(), deps);
      return { state: 'paid', record: receipt.ok ? receipt.record : record };
    }
    return { state: 'paid', record };
  }
  const marker = record.marker;
  const request = storedSolanaRequest(record);
  if (marker?.rail !== 'solana' || request === undefined) {
    return { state: 'waiting', record };
  }
  let expired = false;
  // The finalized slot that proved the expiry, once the index had time to catch up.
  let settledAt: bigint | undefined;
  try {
    const epoch = await deps.rpc.getEpochInfo({ commitment: 'finalized' }).send();
    const lastValid = BigInt(marker.lastValidBlockHeight);
    expired = BigInt(epoch.blockHeight) > lastValid;
    if (BigInt(epoch.blockHeight) > lastValid + EXPIRY_SETTLE_BLOCKS) {
      settledAt = BigInt(epoch.absoluteSlot);
    }
  } catch {
    expired = false;
  }
  // An RPC whose ledger starts above the attempt cannot show it: never "none" from it.
  if (settledAt !== undefined && !(await ledgerReaches(deps.rpc, marker.slot))) {
    settledAt = undefined;
  }
  const search = await searchPayment(record, request, deps.rpc, settledAt);
  if (search !== 'none' && search !== 'unsure') {
    return { state: 'paid', record: await recordPaid(record, search.found, deps) };
  }
  if (!expired) {
    if (marker.signedTransaction !== undefined) {
      await broadcast(deps.rpc, marker.signedTransaction);
    }
    return { state: 'waiting', record };
  }
  // Only a caller whose RPC can prove it (full history) ever acts on "none".
  return search === 'none' && settledAt !== undefined && deps.canProveOver !== false
    ? { state: 'over', record }
    : { state: 'waiting', record };
}

/**
 * A new attempt for the same order, reference and request, once the last one
 * provably ended: the pass runs here, and the marker is replaced only at the
 * version it judged (a payment found meanwhile is never overrun).
 */
export async function retryWithSolana(
  record: OrderRecord,
  wallet: SolanaWallet,
  input: PayInput,
  deps: SolanaPayDeps,
): Promise<SolanaPayResult> {
  if (record.state !== 'paying' || record.marker?.rail !== 'solana') {
    return { ok: false, reason: 'not_payable', record };
  }
  const watch = await watchSolanaPayment(record, deps);
  if (watch.state !== 'over') {
    const reasons = {
      paid: 'already_paid',
      waiting: 'still_waiting',
      closed: 'not_payable',
    } as const;
    return { ok: false, reason: reasons[watch.state], record: watch.record };
  }
  const judged = watch.record;
  const previous = judged.marker;
  if (previous === undefined) {
    return { ok: false, reason: 'not_payable', record: judged };
  }
  const checked = await checkBeforePaying(judged, wallet.address, input, deps);
  if (!checked.ok) {
    return checked;
  }
  let unsigned: Unsigned;
  try {
    unsigned = await unsignedPayment(deps.rpc, checked, wallet.address);
  } catch {
    return { ok: false, reason: 'rpc_error', record: judged };
  }
  const marker = newMarker(unsigned, deps);
  if (!reserveCosts(checked.funds.costs, marker.attemptId, deps)) {
    return { ok: false, reason: 'spend_limit', record: judged };
  }
  const replaced = await withReleaseOnThrow(marker.attemptId, deps, () =>
    deps.store.updateMarker(
      judged.orderId,
      judged.version,
      previous.attemptId,
      marker,
      (deps.now ?? nowSecs)(),
    ),
  );
  if (!replaced.ok) {
    deps.release?.(marker.attemptId);
    return storeRefusal(replaced, judged);
  }
  return signAndSend(replaced.record, marker, unsigned, wallet, checked, deps);
}

/**
 * End an order that will not be paid (the offer changed, the buyer starts over):
 * at once when nothing was requested; with an attempt, only once it provably
 * ended. `ended-unpaid` keeps the marker for later reconciliation.
 */
export async function endSolanaOrder(
  record: OrderRecord,
  deps: SolanaPayDeps,
): Promise<{ ended: boolean; record: OrderRecord }> {
  if (record.state === 'ordered' && record.marker === undefined) {
    const written = await deps.store.update(record.orderId, record.version, {
      state: 'ended-unpaid',
    });
    return written.ok ? { ended: true, record: written.record } : { ended: false, record };
  }
  if (record.state !== 'paying' || record.marker === undefined) {
    return { ended: false, record };
  }
  const watch = await watchSolanaPayment(record, deps);
  if (watch.state !== 'over' || watch.record.marker === undefined) {
    return { ended: false, record: watch.record };
  }
  const written = await deps.store.clearMarker(
    watch.record.orderId,
    watch.record.version,
    watch.record.marker.attemptId,
    'ended-unpaid',
  );
  return written.ok
    ? { ended: true, record: written.record }
    : { ended: false, record: watch.record };
}
