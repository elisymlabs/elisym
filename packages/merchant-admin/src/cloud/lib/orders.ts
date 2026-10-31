/**
 * The owner's orders (`GET /tenants/:id/orders`) as the console reads them,
 * and the owner commands it queues on them (plan section 3). Every field is
 * checked, so a malformed answer is a failure, never "undefined" on screen.
 * Amounts stay subunit strings until shown: a coin the registry knows is
 * formatted with its own decimals (integer math), anything else is shown as
 * the subunits and the asset id it came with.
 */
import { parseCaip19 } from '@elisym/commerce';
import { explorerTxUrl, formatAssetAmount, parseAssetAmount, settlementOf } from '@elisym/pay-core';
import { base58 } from '@scure/base';
import { fieldOf } from './fields';

const SUBUNITS = /^\d{1,78}$/;
/** An order key, a transaction id or an asset as the node's commands take them (cloud-api's check). */
const COMMAND_ARG = /^[A-Za-z0-9:._/-]{1,256}$/;
const WEBHOOK_STATES = ['pending', 'sent', 'failed'] as const;
const HAND_KINDS = ['delivered', 'refunded'] as const;

export interface OrderPaymentRead {
  signature: string;
  amount: string;
  fee: string;
  asset: string;
  /** The rail the node read the payment on (`solana`, `tempo`, ...). */
  medium: string;
  paidAt: number;
}

export interface OrderWebhookRead {
  state: (typeof WEBHOOK_STATES)[number];
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
}

export interface OrderRead {
  key: string;
  buyer: string;
  orderId: string;
  createdAt: number;
  product: string;
  email: string | null;
  customerRef: string | null;
  payment: OrderPaymentRead | null;
  deliveredAt: number | null;
  webhook: OrderWebhookRead | null;
  feeUnresolved: string[];
  blockedTx: string | null;
}

export interface HandAnswerRead {
  key: string;
  kind: (typeof HAND_KINDS)[number];
  tx: string | null;
  amount: string | null;
  asset: string | null;
}

export interface UnresolvedPaymentRead {
  key: string;
  tx: string;
  at: number;
}

export interface OrdersRead {
  orders: OrderRead[];
  answeredByHand: HandAnswerRead[];
  closed: string[];
  unresolvedPayments: UnresolvedPaymentRead[];
}

/** A malformed field: the whole answer is refused. */
class Malformed extends Error {}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Malformed();
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Malformed();
  }
  return value;
}

function optionalCount(value: unknown): number | null {
  return value === null ? null : count(value);
}

function subunits(value: unknown): string {
  if (typeof value !== 'string' || !SUBUNITS.test(value)) {
    throw new Malformed();
  }
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Malformed();
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  const found = allowed.find((each) => each === value);
  if (found === undefined) {
    throw new Malformed();
  }
  return found;
}

function paymentOf(value: unknown): OrderPaymentRead | null {
  if (value === null) {
    return null;
  }
  return {
    signature: text(fieldOf(value, 'signature')),
    amount: subunits(fieldOf(value, 'amount')),
    fee: subunits(fieldOf(value, 'fee')),
    asset: text(fieldOf(value, 'asset')),
    medium: text(fieldOf(value, 'medium')),
    paidAt: count(fieldOf(value, 'paidAt')),
  };
}

function webhookOf(value: unknown): OrderWebhookRead | null {
  if (value === null) {
    return null;
  }
  return {
    state: oneOf(fieldOf(value, 'state'), WEBHOOK_STATES),
    attempts: count(fieldOf(value, 'attempts')),
    lastStatus: optionalCount(fieldOf(value, 'lastStatus')),
    lastError: optionalText(fieldOf(value, 'lastError')),
  };
}

function orderOf(value: unknown): OrderRead {
  return {
    key: text(fieldOf(value, 'key')),
    buyer: text(fieldOf(value, 'buyer')),
    orderId: text(fieldOf(value, 'orderId')),
    createdAt: count(fieldOf(value, 'createdAt')),
    product: text(fieldOf(value, 'product')),
    email: optionalText(fieldOf(value, 'email')),
    customerRef: optionalText(fieldOf(value, 'customerRef')),
    payment: paymentOf(fieldOf(value, 'payment')),
    deliveredAt: optionalCount(fieldOf(value, 'deliveredAt')),
    webhook: webhookOf(fieldOf(value, 'webhook')),
    feeUnresolved: list(fieldOf(value, 'feeUnresolved')).map(text),
    blockedTx: optionalText(fieldOf(value, 'blockedTx')),
  };
}

function handAnswerOf(value: unknown): HandAnswerRead {
  const amount = fieldOf(value, 'amount');
  return {
    key: text(fieldOf(value, 'key')),
    kind: oneOf(fieldOf(value, 'kind'), HAND_KINDS),
    tx: optionalText(fieldOf(value, 'tx')),
    amount: amount === null ? null : subunits(amount),
    asset: optionalText(fieldOf(value, 'asset')),
  };
}

function unresolvedOf(value: unknown): UnresolvedPaymentRead {
  return {
    key: text(fieldOf(value, 'key')),
    tx: text(fieldOf(value, 'tx')),
    at: count(fieldOf(value, 'at')),
  };
}

/** The orders from an answer's body, or undefined when any field is not what it must be. */
export function ordersReadOf(body: unknown): OrdersRead | undefined {
  try {
    return {
      orders: list(fieldOf(body, 'orders')).map(orderOf),
      answeredByHand: list(fieldOf(body, 'answeredByHand')).map(handAnswerOf),
      closed: list(fieldOf(body, 'closed')).map(text),
      unresolvedPayments: list(fieldOf(body, 'unresolvedPayments')).map(unresolvedOf),
    };
  } catch (error) {
    if (error instanceof Malformed) {
      return undefined;
    }
    throw error;
  }
}

/** An amount as the merchant reads it: in the coin's own units when the registry knows it. */
export function shownAmount(amount: string, asset: string): string {
  const known = parseCaip19(asset);
  return known === undefined
    ? `${amount} subunits of ${asset}`
    : formatAssetAmount(known.asset, BigInt(amount));
}

/** The explorer page of a transaction on the asset's chain, when the registry knows the chain. */
export function txLink(tx: string, asset: string): string | undefined {
  const known = parseCaip19(asset);
  return known === undefined ? undefined : explorerTxUrl(known.chain, tx);
}

/** A refund amount typed in the coin's units, as subunits; undefined when it is not one. */
export function refundSubunits(human: string, asset: string): string | undefined {
  const known = parseCaip19(asset);
  if (known === undefined) {
    return undefined;
  }
  try {
    return parseAssetAmount(known.asset, human.trim()).toString();
  } catch {
    return undefined;
  }
}

/** A Tempo transaction hash as the node takes it: lowercase. */
const TEMPO_HASH = /^0x[0-9a-f]{64}$/;
const SOLANA_SIGNATURE_BYTES = 64;

/**
 * A refund transaction pasted for `asset`, as the node takes it (a Tempo hash
 * lowercased, a Solana signature as is), or undefined when it is not one of
 * the asset's rail: the node reads refunds on Solana and Tempo only.
 */
export function refundTxOf(pasted: string, asset: string): string | undefined {
  const known = parseCaip19(asset);
  const rail = known === undefined ? undefined : settlementOf(known.chain);
  const tx = pasted.trim();
  if (rail === 'tempo') {
    const lowered = tx.toLowerCase();
    return TEMPO_HASH.test(lowered) ? lowered : undefined;
  }
  if (rail === 'solana') {
    try {
      return base58.decode(tx).length === SOLANA_SIGNATURE_BYTES ? tx : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * An owner command on one order, as the console asks it. `again`: the order
 * was answered by hand already and the answer is sent once more (the node
 * sends the answer it kept again, as its own error asks when too few relays took it).
 */
export type OrderCommand =
  | { kind: 'complete'; key: string; again: boolean }
  | {
      kind: 'refund';
      key: string;
      tx: string;
      amount: string;
      /** Null for an answer kept without one (sent again, it stays without). */
      asset: string | null;
      again: boolean;
    }
  | { kind: 'webhook retry'; key: string }
  | { kind: 'webhook resend'; key: string };

/** The node's arguments for a command, or undefined when a value is not one it takes. */
export function commandArgs(command: OrderCommand): string[] | undefined {
  let values: string[];
  let args: string[];
  switch (command.kind) {
    case 'complete':
      values = [command.key];
      args = ['complete', command.key];
      break;
    case 'refund':
      values = [command.key, command.tx, command.amount];
      args = ['refund', command.key, '--tx', command.tx, '--amount', command.amount];
      if (command.asset !== null) {
        values.push(command.asset);
        args.push('--asset', command.asset);
      }
      break;
    case 'webhook retry':
      values = [command.key];
      args = ['webhook', 'retry', command.key];
      break;
    case 'webhook resend':
      values = [command.key];
      args = ['webhook', 'resend', command.key];
      break;
  }
  // A value starting with `-` would read as a flag.
  return values.every((value) => COMMAND_ARG.test(value) && !value.startsWith('-'))
    ? args
    : undefined;
}

/** What a command does, as its confirmation says it. */
export function commandConsequence(command: OrderCommand): string {
  switch (command.kind) {
    case 'complete':
      return command.again
        ? `Send the "completed" answer of order ${command.key} once more: the order is closed already, and the buyer may not have it yet.`
        : `Close order ${command.key} and send the buyer "completed". It sends no webhook: credit it by hand.`;
    case 'refund': {
      const refunded =
        command.asset === null
          ? `${command.amount} subunits`
          : shownAmount(command.amount, command.asset);
      return command.again
        ? `Send the refund report of order ${command.key} (${refunded} in ${command.tx}) once more: the order is closed already, and the buyer may not have it yet.`
        : `Close order ${command.key} and tell the buyer you refunded ${refunded} in ${command.tx}. Send the refund yourself first: this only reports it.`;
    }
    case 'webhook retry':
      return `Send the order.paid webhook of ${command.key} again now.`;
    case 'webhook resend':
      return `Send the order.paid webhook of ${command.key} once more. Your receiver dedupes on its event id.`;
  }
}

/** Where a queued command stands, from `GET /tenants/:id/cycles/:cycle`. */
export type CommandState =
  | { stage: 'waiting' }
  /** `output`: what the command printed (its warnings among it), capped; empty when it printed nothing. */
  | { stage: 'done'; output: string }
  /**
   * `retried`: the cloud runs it again by itself (as a new cycle): it is still under way. Store
   * cycles only: a command never retries.
   */
  | { stage: 'failed'; reason: string; retried: boolean }
  | { stage: 'replaced' };

/** The longest reason shown from a failed command's own words. */
const MAX_REASON_CHARS = 300;
/** The longest output shown from a command that went through. */
const MAX_OUTPUT_CHARS = 2000;

function reasonOf(outcome: unknown): string {
  const message = fieldOf(outcome, 'message');
  const stderr = fieldOf(outcome, 'stderr');
  const line =
    typeof stderr === 'string'
      ? stderr
          .split('\n')
          .map((each) => each.trim())
          .find((each) => each !== '')
      : undefined;
  const reason = line ?? (typeof message === 'string' ? message : undefined);
  return reason === undefined ? 'the store did not say why' : reason.slice(0, MAX_REASON_CHARS);
}

function outputOf(outcome: unknown): string {
  const stdout = fieldOf(outcome, 'stdout');
  return typeof stdout === 'string' ? stdout.trim().slice(0, MAX_OUTPUT_CHARS) : '';
}

/** A cycle's status as a command's state, or undefined when the answer is malformed. */
export function commandStateOf(body: unknown): CommandState | undefined {
  switch (fieldOf(body, 'status')) {
    case 'queued':
    case 'running':
      return { stage: 'waiting' };
    case 'done':
      return { stage: 'done', output: outputOf(fieldOf(body, 'outcome')) };
    case 'failed':
      return {
        stage: 'failed',
        reason: reasonOf(fieldOf(body, 'outcome')),
        retried: fieldOf(fieldOf(body, 'outcome'), 'verdict') === 'retry',
      };
    case 'replaced':
      return { stage: 'replaced' };
    default:
      return undefined;
  }
}
