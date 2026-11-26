/**
 * Owner events, step by step (A13): prepare -> local check -> (the page
 * confirms) -> sign -> commit -> follow. Each step answers in fixed
 * sentences; no text the server sent is ever shown.
 */
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { ApiError, type HostedApi } from './api';
import { coinLabel } from './coins';
import { errorMessage, requestFailureMessage } from './errors';
import { type TemplateProblem, checkOwnerTemplate } from './owner-event-check';
import type { CommitAnswer, OwnerEventKind, Payout, RequestView } from './types';

export type FlowApi = Pick<HostedApi, 'prepareOwnerEvent' | 'commitOwnerEvent' | 'request'>;

/** Refusals of a commit that a fresh prepare fixes: the page prepares again, once, by itself. */
export const PREPARE_AGAIN_CODES: ReadonlySet<string> = new Set([
  'stale',
  'clock',
  'expired',
  'mismatch',
  'no_draft',
]);

/** A followed request is read this often, this many times (2 s, up to 30 s). */
export const FOLLOW_INTERVAL_MS = 2000;
export const FOLLOW_ATTEMPTS = 15;

export const TEMPLATE_PROBLEMS: Readonly<Record<TemplateProblem, string>> = {
  malformed: 'The server sent a change this page cannot read, so it was not signed.',
  kind: 'The server sent another kind of change than the one asked for, so it was not signed.',
  content: 'The server sent a change with unexpected content, so it was not signed.',
  date: 'The server sent a change dated in the future, so it was not signed. Check that your computer clock is right.',
  payouts:
    'The payout list the server sent differs from your payout addresses, so it was not signed. Reload the page and check your payouts.',
  tags: 'The server sent a change with unexpected fields, so it was not signed.',
  store: 'The server sent an authorization for another store, so it was not signed.',
  operator: 'The server sent an authorization for another operator or mode, so it was not signed.',
};

export const UNSIGNED_PAYOUT_NAMED = (coin: string) =>
  `Your ${coin} payout address has no wallet signature. Sign it with its wallet, save, then retry.`;
export const DONE = 'Signed and published.';
export const ON_ACTIVATION =
  'Signed. It goes live when PayCore activates your store; nothing else to do now.';
export const STILL_APPLYING = 'Signed. Your store is still applying it: press Refresh in a moment.';

/** A prepared template that passed the local check, with the payout addresses it names. */
export interface Checked {
  template: EventTemplate;
  /** 10133: the `accept` lines in order (caip19, address as the template names it). */
  accept: { caip19: string; address: string }[];
}

export type PrepareOutcome = { ok: true; checked: Checked } | { ok: false; message: string };

export interface PrepareInput {
  kind: OwnerEventKind;
  payouts: readonly Payout[];
  storePubkey: string;
  operator: string;
  localNow: number;
}

/** The coin a refusal names in its `message`, when that is a coin id the registry knows. */
function namedCoin(error: ApiError): string | undefined {
  const message = error.detail.message;
  return typeof message === 'string' ? coinLabel(message) : undefined;
}

/** Why a prepare or commit was refused, in a fixed sentence. */
export function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'unsigned_payout') {
    const coin = namedCoin(error);
    if (coin !== undefined) {
      return UNSIGNED_PAYOUT_NAMED(coin);
    }
  }
  return errorMessage(error);
}

export async function prepareChecked(api: FlowApi, input: PrepareInput): Promise<PrepareOutcome> {
  let template: unknown;
  try {
    ({ template } = await api.prepareOwnerEvent(input.kind));
  } catch (error) {
    return { ok: false, message: refusalMessage(error) };
  }
  const checked = checkOwnerTemplate({ ...input, template });
  if (!checked.ok) {
    return { ok: false, message: TEMPLATE_PROBLEMS[checked.problem] };
  }
  const accept = checked.template.tags.flatMap((tag) => {
    const [name, caip19, address] = tag;
    return name === 'accept' && caip19 !== undefined && address !== undefined
      ? [{ caip19, address }]
      : [];
  });
  return { ok: true, checked: { template: checked.template, accept } };
}

export type CommitOutcome =
  | { kind: 'done' }
  /** A pending store: committed, applied at its activation. */
  | { kind: 'on_activation' }
  | { kind: 'follow'; requestId: string }
  | { kind: 'failed'; message: string }
  /** Refused before it was taken; `prepareAgain` when a fresh prepare may fix it. */
  | { kind: 'refused'; prepareAgain: boolean; message: string };

/**
 * What a queued request's answer means: applied (200), failed (422), or
 * pending (202: followed on an active store, applied at activation on a
 * pending one). Owner events, hand answers and suspensions all answer so.
 */
export function requestOutcome(
  request: CommitAnswer['request'],
  pendingStore: boolean,
): Exclude<CommitOutcome, { kind: 'refused' }> {
  if (request === undefined) {
    // Committed before: on a pending store it still waits for the activation.
    return pendingStore ? { kind: 'on_activation' } : { kind: 'done' };
  }
  if (request.state === 'applied') {
    return { kind: 'done' };
  }
  if (request.state === 'failed') {
    return { kind: 'failed', message: requestFailureMessage(failedResult(request)) };
  }
  return pendingStore ? { kind: 'on_activation' } : { kind: 'follow', requestId: request.id };
}

function failedResult(request: { state: 'pending'; id: string } | RequestView): unknown {
  return 'result' in request ? request.result : undefined;
}

/** Hand O's signed event to the server: what came of it. */
export async function commitSigned(
  api: FlowApi,
  event: NostrEvent,
  pendingStore: boolean,
): Promise<CommitOutcome> {
  let answer: CommitAnswer;
  try {
    answer = await api.commitOwnerEvent(event);
  } catch (error) {
    return {
      kind: 'refused',
      prepareAgain: error instanceof ApiError && PREPARE_AGAIN_CODES.has(error.code),
      message: refusalMessage(error),
    };
  }
  return requestOutcome(answer.request, pendingStore);
}

export type FollowOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; message: string }
  /** Still pending after every read, or the reads failed. */
  | { kind: 'still' };

export interface FollowOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The page left: no further reads. */
  signal?: AbortSignal;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Read request `id` every 2 s until it is applied or failed, at most 30 s; a read that fails is skipped. */
export async function followRequest(
  api: Pick<HostedApi, 'request'>,
  id: string,
  options: FollowOptions = {},
): Promise<FollowOutcome> {
  const attempts = options.attempts ?? FOLLOW_ATTEMPTS;
  const sleep = options.sleep ?? delay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(FOLLOW_INTERVAL_MS);
    if (options.signal?.aborted === true) {
      return { kind: 'still' };
    }
    let request: RequestView;
    try {
      ({ request } = await api.request(id));
    } catch {
      continue;
    }
    if (request.state === 'applied') {
      return { kind: 'done' };
    }
    if (request.state === 'failed') {
      return { kind: 'failed', message: requestFailureMessage(request.result) };
    }
  }
  return { kind: 'still' };
}

/** What the page says once a request was taken and applied, applies at activation, or is still applying. */
export interface FinishTexts {
  done: string;
  onActivation: string;
  still: string;
}

export const OWNER_EVENT_TEXTS: FinishTexts = {
  done: DONE,
  onActivation: ON_ACTIVATION,
  still: STILL_APPLYING,
};

/** What the page says once a commit was taken (or failed after it). */
export interface Finished {
  tone: 'info' | 'error';
  message: string;
  /** Still applying: Refresh reads this request again. */
  stillId?: string;
}

/** A commit's outcome, followed to its end when the store is active. */
export async function finishCommit(
  api: Pick<HostedApi, 'request'>,
  outcome: Exclude<CommitOutcome, { kind: 'refused' }>,
  options: FollowOptions = {},
  texts: FinishTexts = OWNER_EVENT_TEXTS,
): Promise<Finished> {
  if (outcome.kind === 'done') {
    return { tone: 'info', message: texts.done };
  }
  if (outcome.kind === 'on_activation') {
    return { tone: 'info', message: texts.onActivation };
  }
  if (outcome.kind === 'failed') {
    return { tone: 'error', message: outcome.message };
  }
  const followed = await followRequest(api, outcome.requestId, options);
  if (followed.kind === 'done') {
    return { tone: 'info', message: texts.done };
  }
  if (followed.kind === 'failed') {
    return { tone: 'error', message: followed.message };
  }
  return { tone: 'info', message: texts.still, stillId: outcome.requestId };
}

/** Refresh: read a still-applying request once more. */
export async function refreshRequest(
  api: Pick<HostedApi, 'request'>,
  id: string,
  texts: FinishTexts = OWNER_EVENT_TEXTS,
): Promise<Finished> {
  return finishCommit(
    api,
    { kind: 'follow', requestId: id },
    {
      attempts: 1,
      sleep: async () => undefined,
    },
    texts,
  );
}
