/**
 * The `order.paid` webhook: the node, and only the node, tells the merchant's
 * backend about a payment it verified on chain. Each paid order holds an outbox
 * entry (see `recordPayment`), sent until a 2xx or its deadline. The request is
 * signed with a secret only the node and the backend hold.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCaip19 } from '@elisym/commerce';
import {
  type OrderPaidWebhookEvent,
  type TestWebhookEvent,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_MIN_SECRET_BYTES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  signWebhook,
} from '@elisym/commerce/webhook';
import Decimal from 'decimal.js-light';
import {
  MAX_WEBHOOKS_IN_FLIGHT,
  WEBHOOK_DEADLINE_SECS,
  WEBHOOK_FIRST_PAUSE_SECS,
  WEBHOOK_MAX_ANSWER_BYTES,
  WEBHOOK_MAX_PAUSE_SECS,
  WEBHOOK_TIMEOUT_MS,
} from './constants';
import type { LedgerState, MerchantOrder, WebhookEntry } from './ledger';
import { printable } from './printable';

export const WEBHOOK_SECRET_ENV = 'ELISYM_MERCHANT_WEBHOOK_SECRET';
export const WEBHOOK_SECRET_FILE_ENV = 'ELISYM_MERCHANT_WEBHOOK_SECRET_FILE';
export const WEBHOOK_SECRET_HINT = `set ${WEBHOOK_SECRET_FILE_ENV} (or ${WEBHOOK_SECRET_ENV}); make one with: openssl rand -hex 32`;

/** The longest `lastError` kept: a short reason, never a page of output. */
const MAX_ERROR_LENGTH = 200;

/** Where and how the node signs its webhooks. */
export interface WebhookTarget {
  url: string;
  /** The HMAC key, as a UTF-8 string: the same bytes on both sides. */
  secret: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The webhook secret from `ELISYM_MERCHANT_WEBHOOK_SECRET` or the file
 * `ELISYM_MERCHANT_WEBHOOK_SECRET_FILE` names (one trailing newline dropped), or
 * `undefined` when neither is set. The passphrase's rules: an empty variable is
 * unset, an empty file is an error, both set is an error. Its length is judged
 * by `webhookTarget`, only when a webhook is configured.
 */
export function readWebhookSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const direct = env[WEBHOOK_SECRET_ENV];
  const file = env[WEBHOOK_SECRET_FILE_ENV];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = file !== undefined && file !== '';
  if (hasDirect && hasFile) {
    throw new Error(`set ${WEBHOOK_SECRET_ENV} or ${WEBHOOK_SECRET_FILE_ENV}, not both`);
  }
  let secret: string;
  if (hasFile) {
    secret = readFile(file).replace(/\r?\n$/, '');
    if (secret === '') {
      throw new Error(`the webhook secret file ${file} is empty`);
    }
  } else if (hasDirect) {
    secret = direct;
  } else {
    return undefined;
  }
  return secret;
}

/**
 * Said once when `run` starts with no webhook: the buyer gets nothing in-band,
 * so a paid order reaches the merchant only through these two (a notice, not a
 * refusal: a store may fulfil by hand).
 */
export const NO_WEBHOOK_NOTICE =
  'no webhook: paid orders reach you only through orders and the admin page';

/**
 * The target a node runs with: a configured webhook needs its secret, at least
 * `WEBHOOK_MIN_SECRET_BYTES` bytes, so a missing or short one refuses to start;
 * a secret without a webhook is only a warning, whatever its length.
 */
export function webhookTarget(
  webhook: { url: string } | undefined,
  secret: string | undefined,
): { target?: WebhookTarget; warning?: string; notice?: string } {
  if (webhook === undefined) {
    return secret === undefined
      ? { notice: NO_WEBHOOK_NOTICE }
      : {
          warning: `${WEBHOOK_SECRET_ENV} is set but config.json has no webhook: none is sent`,
          notice: NO_WEBHOOK_NOTICE,
        };
  }
  if (secret === undefined) {
    throw new Error(`config.json has a webhook and no secret is set: ${WEBHOOK_SECRET_HINT}`);
  }
  if (Buffer.byteLength(secret, 'utf8') < WEBHOOK_MIN_SECRET_BYTES) {
    throw new Error(
      `the webhook secret is shorter than ${WEBHOOK_MIN_SECRET_BYTES} bytes; make one with: openssl rand -hex 32`,
    );
  }
  return { target: { url: webhook.url, secret } };
}

/**
 * The `order.paid` body of a paid order, compact JSON in a fixed key order. It
 * carries what the node verified on chain - the asset and amount paid - never
 * the buyer's claimed total; `customerRef` and `email` only when the order has them.
 */
export function orderPaidBody(
  order: MerchantOrder,
  entry: Pick<WebhookEntry, 'eventId'>,
  store: { storePubkey: string },
): string {
  const paid = order.paid;
  if (paid === undefined) {
    throw new Error(`${order.key} is not paid: no webhook`);
  }
  // A payment recorded before protocol-fee support carries no fee.
  const fee = paid.fee ?? '0';
  const asset = parseCaip19(paid.caip19)?.asset;
  const display =
    asset === undefined
      ? {}
      : {
          amountDisplay: new Decimal(paid.amount)
            .div(new Decimal(10).pow(asset.decimals))
            .toString(),
          decimals: asset.decimals,
          symbol: asset.symbol,
        };
  return JSON.stringify({
    event: 'order.paid',
    eventId: entry.eventId,
    store: store.storePubkey,
    orderId: order.orderId,
    buyerPubkey: order.buyerPubkey,
    ...(order.customerRef === undefined ? {} : { customerRef: order.customerRef }),
    // The product the order named: every order carries one.
    product: { address: order.product },
    payment: {
      asset: paid.caip19,
      amount: paid.amount,
      fee,
      net: (BigInt(paid.amount) - BigInt(fee)).toString(),
      ...display,
      tx: paid.signature,
      medium: paid.medium,
      paidAt: paid.blockTime,
    },
    ...(order.email === undefined ? {} : { email: order.email }),
  } satisfies OrderPaidWebhookEvent);
}

/** A `test` body: it checks the receiver's signature check, and credits nothing. */
export function testBody(storePubkey: string): { body: string; eventId: string } {
  const eventId = randomBytes(32).toString('hex');
  return {
    body: JSON.stringify({ event: 'test', eventId, store: storePubkey } satisfies TestWebhookEvent),
    eventId,
  };
}

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

/** Whether a fetch error is a redirect refused by `redirect: 'error'` (Bun and Node word it differently). */
function isRedirectError(error: unknown): boolean {
  const parts: unknown[] = [error, error instanceof Error ? error.cause : undefined];
  return parts.some(
    (part) =>
      part instanceof Error &&
      (/redirect/i.test(part.message) || ('code' in part && part.code === 'UnexpectedRedirect')),
  );
}

/**
 * A short, printable reason a request failed. It is kept in the ledger and
 * logged, so it never holds the URL beyond its origin: a token in the URL's
 * path or query stays out (Bun's errors quote the full URL).
 */
export function failureText(error: unknown, url?: string): string {
  if (isRedirectError(error)) {
    return 'redirect refused';
  }
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
    text = `${text}: ${cause.message}${code}`;
  }
  if (url !== undefined && URL.canParse(url)) {
    const parsed = new URL(url);
    for (const spelling of [url, parsed.href]) {
      text = text.split(spelling).join(parsed.origin);
    }
  }
  return printable(text).slice(0, MAX_ERROR_LENGTH);
}

/** Read at most `WEBHOOK_MAX_ANSWER_BYTES` of the answer, then drop the rest. */
async function drainAnswer(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return;
  }
  let read = 0;
  try {
    while (read < WEBHOOK_MAX_ANSWER_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      read += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * POST one signed event. No redirect is followed (a 3xx fails), the whole
 * exchange is bounded by `WEBHOOK_TIMEOUT_MS`, and the answer body is read up
 * to 4 KiB and dropped. A 2xx is the only success.
 */
export async function sendWebhook(
  target: WebhookTarget,
  event: { name: string; eventId: string; body: string },
  options: { now: () => number; userAgent: string; fetch?: FetchLike; timeoutMs?: number },
): Promise<SendResult> {
  const timestamp = options.now();
  const doFetch: FetchLike = options.fetch ?? fetch;
  try {
    const signature = await signWebhook({ secret: target.secret, timestamp, body: event.body });
    const response = await doFetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': options.userAgent,
        [WEBHOOK_EVENT_HEADER]: event.name,
        [WEBHOOK_EVENT_ID_HEADER]: event.eventId,
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
      body: event.body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
    await drainAnswer(response).catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: failureText(error, target.url) };
  }
}

/**
 * The pause before the next attempt after `attempts` failed ones: 30 s doubled
 * per attempt up to an hour, plus up to 10 % jitter (`random` in [0, 1)).
 */
export function retryPause(attempts: number, random: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  const base = Math.min(WEBHOOK_MAX_PAUSE_SECS, WEBHOOK_FIRST_PAUSE_SECS * 2 ** exponent);
  return base + Math.floor(base * 0.1 * random);
}

/** Write one attempt's outcome on the entry. */
export function applySendResult(
  entry: WebhookEntry,
  result: SendResult,
  now: number,
  random: number,
): void {
  entry.attempts += 1;
  if (result.status === undefined) {
    delete entry.lastStatus;
  } else {
    entry.lastStatus = result.status;
  }
  if (result.ok) {
    entry.state = 'sent';
    entry.sentAt = now;
    delete entry.lastError;
    return;
  }
  entry.lastError = result.error;
  if (now >= entry.deadline) {
    entry.state = 'failed';
    return;
  }
  entry.nextAt = now + retryPause(entry.attempts, random);
}

/** Make an entry pending again, due now, with a fresh deadline (`webhook retry` / `resend`). */
export function rearm(entry: WebhookEntry, now: number): void {
  entry.state = 'pending';
  entry.createdAt = now;
  entry.deadline = now + WEBHOOK_DEADLINE_SECS;
  entry.attempts = 0;
  entry.nextAt = now;
  delete entry.lastStatus;
  delete entry.lastError;
  delete entry.sentAt;
}

export interface WebhookSenderDeps {
  state: LedgerState;
  store: { storePubkey: string };
  target: WebhookTarget;
  /**
   * Apply a change to the ledger and save it, on the node's one queue: the
   * sender never writes the ledger between another task's steps.
   */
  commit: (change: () => void) => void;
  log: (message: string) => void;
  now: () => number;
  userAgent: string;
  fetch?: FetchLike;
  /** In [0, 1): the retry jitter. */
  random?: () => number;
  /** Replaceable in tests: `WEBHOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Sends the pending webhooks that are due, a few at a time. An entry is in
 * flight from its pick until its outcome is committed, so it is never sent
 * twice at once. The HTTP calls run off the queue; only their outcome is queued.
 */
export class WebhookSender {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: WebhookSenderDeps) {}

  /** How many entries are being sent now. */
  get sending(): number {
    return this.inFlight.size;
  }

  /** Start the due entries the in-flight limit allows; resolves once those are sent and committed. */
  async tick(): Promise<void> {
    const { state, commit, log, now } = this.deps;
    const at = now();
    const due: { order: MerchantOrder; entry: WebhookEntry }[] = [];
    for (const order of Object.values(state.orders)) {
      const entry = order.webhook;
      if (entry?.state === 'pending' && entry.nextAt <= at && !this.inFlight.has(entry.eventId)) {
        due.push({ order, entry });
      }
    }
    due.sort((left, right) => left.entry.nextAt - right.entry.nextAt);
    const sends: Promise<void>[] = [];
    for (const { order, entry } of due) {
      if (this.inFlight.size >= MAX_WEBHOOKS_IN_FLIGHT) {
        break;
      }
      this.inFlight.add(entry.eventId);
      if (at >= entry.deadline) {
        commit(() => {
          this.inFlight.delete(entry.eventId);
          entry.state = 'failed';
          log(`webhook ${entry.eventId} for ${order.key}: failed, past its deadline`);
        });
        continue;
      }
      sends.push(this.send(order, entry));
    }
    await Promise.all(sends);
  }

  private async send(order: MerchantOrder, entry: WebhookEntry): Promise<void> {
    const { target, store, commit, log, now, userAgent } = this.deps;
    let result: SendResult;
    try {
      result = await sendWebhook(
        target,
        { name: 'order.paid', eventId: entry.eventId, body: orderPaidBody(order, entry, store) },
        {
          now,
          userAgent,
          ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
          ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
        },
      );
    } catch (error) {
      result = { ok: false, error: failureText(error, target.url) };
    }
    const random = (this.deps.random ?? Math.random)();
    commit(() => {
      this.inFlight.delete(entry.eventId);
      applySendResult(entry, result, now(), random);
      log(`webhook ${entry.eventId} for ${order.key}: ${outcomeText(entry, result)}`);
    });
  }
}

/** One attempt's outcome, as logged and printed. */
export function outcomeText(entry: WebhookEntry, result: SendResult): string {
  if (result.ok) {
    return `sent (${result.status})`;
  }
  return entry.state === 'failed'
    ? `failed for good: ${result.error}`
    : `not taken (${result.error}), attempt ${entry.attempts}`;
}
