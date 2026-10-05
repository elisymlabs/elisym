/**
 * The rules of the `orders` listing and of `webhook retry` / `resend`, pure so
 * the CLI only sequences them (lock, ledger, one send, save).
 */
import {
  type LedgerState,
  type MerchantOrder,
  type WebhookEntry,
  newWebhookEntry,
  webhookEventId,
} from './ledger';
import { printable } from './printable';
import { orderProductD } from './products';
import { rearm } from './webhook';

/** A customer reference is shown at most this long in `orders`. */
const MAX_SHOWN_REF_LENGTH = 24;

export type RearmKind = 'retry' | 'resend';

export type RearmPlan =
  | { ok: true; order: MerchantOrder; entry: WebhookEntry }
  | { ok: false; problem: string };

/**
 * Make the webhook of the order `key` pending again, due now, with a fresh
 * deadline. `retry` takes an entry still pending or failed; `resend` writes one
 * for any paid order the ledger holds (paid before the webhook was configured,
 * or already sent: the receiver dedupes on the same event id).
 */
export function rearmWebhook(
  state: LedgerState,
  key: string,
  kind: RearmKind,
  storePubkey: string,
  now: number,
): RearmPlan {
  const order = state.orders[key];
  if (order === undefined) {
    return {
      ok: false,
      problem:
        state.answeredByHand?.[key] === undefined
          ? `no order ${key} in the ledger`
          : `${key} was answered by hand: it sends no webhook, credit it by hand`,
    };
  }
  if (order.paid === undefined) {
    return { ok: false, problem: `${key} is not paid: there is nothing to send` };
  }
  if (kind === 'resend') {
    const entry = newWebhookEntry(storePubkey, order, now);
    order.webhook = entry;
    return { ok: true, order, entry };
  }
  const entry = order.webhook;
  if (entry === undefined) {
    return {
      ok: false,
      problem: `${key} has no webhook (paid before one was configured): use webhook resend`,
    };
  }
  if (entry.state === 'sent') {
    return { ok: false, problem: `${key} was sent already: use webhook resend to send it again` };
  }
  rearm(entry, now);
  return { ok: true, order, entry };
}

/** A customer reference as `orders` prints it: printable, and cut to a column. */
export function shownRef(ref: string): string {
  const safe = printable(ref);
  return safe.length > MAX_SHOWN_REF_LENGTH
    ? `${safe.slice(0, MAX_SHOWN_REF_LENGTH - 3)}...`
    : safe;
}

function orderStatus(order: MerchantOrder): string {
  if (order.paid === undefined) {
    return 'open';
  }
  return order.deliveredAt === undefined ? 'paid, delivering' : 'delivered';
}

/**
 * The `orders` listing, one line per order then per hand answer. A paid order
 * shows its webhook state (`none` without an entry) and its event id, which a
 * credit made by hand records, so the webhook never credits it again.
 */
export function orderLines(state: LedgerState, storePubkey: string): string[] {
  const all = Object.values(state.orders).sort((left, right) => left.createdAt - right.createdAt);
  const lines = all.map((order) => {
    const when = new Date(order.createdAt * 1000).toISOString();
    const paid = order.paid === undefined ? '' : ` ${order.paid.amount} ${order.paid.signature}`;
    const email = order.email === undefined ? '' : ` email=${printable(order.email)}`;
    const ref = order.customerRef === undefined ? '' : ` ref=${shownRef(order.customerRef)}`;
    const webhook =
      order.paid === undefined
        ? ''
        : ` webhook=${order.webhook?.state ?? 'none'} event=${webhookEventId(storePubkey, order.key, order.paid.signature)}`;
    return `${when} ${orderStatus(order)} ${order.key} product=${printable(orderProductD(order))}${paid}${email}${ref}${webhook}`;
  });
  lines.push(`${all.length} order(s)`);
  for (const [key, answer] of Object.entries(state.answeredByHand ?? {})) {
    const detail =
      answer.kind === 'delivered'
        ? (answer.delivery?.value ?? '')
        : `${answer.amount ?? ''} in ${answer.tx ?? ''}`;
    const ref = answer.customerRef === undefined ? '' : ` ref=${shownRef(answer.customerRef)}`;
    lines.push(`answered by hand: ${key} ${answer.kind} ${detail}${ref}`);
  }
  return lines;
}
