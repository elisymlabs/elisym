/**
 * Moving a hosted store to a new owner key O' (both keys sign): prepare ->
 * local check of every template -> O' signs the payout list and the
 * authorization, O signs the revocation of its own authorization -> the move,
 * authorized by both keys. Each step answers in fixed sentences; no text the
 * server sent is ever shown.
 */
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { ApiError, type HostedApi } from './api';
import { GENERIC_ERROR, errorMessage } from './errors';
import {
  KIND_AUTHORIZATION,
  MAX_AHEAD_SECS,
  checkOwnerTemplate,
  sameAddress,
} from './owner-event-check';
import {
  type CommitOutcome,
  PREPARE_AGAIN_CODES,
  TEMPLATE_PROBLEMS,
  requestOutcome,
} from './owner-flow';
import type { Signer } from './signer';
import type { MoveAnswer, MoveInput, MoveTemplates, Payout, StoreView } from './types';

export type MoveApi = Pick<HostedApi, 'prepareMove' | 'move'>;

export const SAME_KEY = 'That is the owner key you are signed in with. Use a new key.';
export const STORE_KEY =
  "That is your store's own key, which PayCore holds. Use a new key that only you have.";
export const BAD_REVOCATION =
  'The server sent a revocation this page did not expect, so nothing was signed.';

/** The payouts the store sells on now: the active payout list, or the saved ones before the first. */
export function currentPayouts(view: StoreView): Payout[] {
  return view.activePayouts?.payouts ?? view.config?.draftPayouts ?? [];
}

/** Why `to` (hex) cannot be the new owner key of this store, or undefined. */
export function newKeyProblem(to: string, view: StoreView): string | undefined {
  if (to === view.owner) {
    return SAME_KEY;
  }
  if (to === view.storePubkey) {
    return STORE_KEY;
  }
  return undefined;
}

/** The revocation of O's authorization of this store: exactly `d`, `p` and `mode revoked`. */
export function badRevocation(template: unknown, storePubkey: string, localNow: number): boolean {
  if (typeof template !== 'object' || template === null || Array.isArray(template)) {
    return true;
  }
  const kind: unknown = Reflect.get(template, 'kind');
  const content: unknown = Reflect.get(template, 'content');
  const createdAt: unknown = Reflect.get(template, 'created_at');
  const tags: unknown = Reflect.get(template, 'tags');
  const expected = [
    ['d', storePubkey],
    ['p', storePubkey],
    ['mode', 'revoked'],
  ];
  return (
    kind !== KIND_AUTHORIZATION ||
    content !== '' ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > localNow + MAX_AHEAD_SECS ||
    JSON.stringify(tags) !== JSON.stringify(expected)
  );
}

/**
 * `payouts` in the order the template's `accept` lines name them, so the
 * local check compares the same set whatever order the server built; any
 * other set is left as it is, and the check refuses it.
 */
function inTemplateOrder(template: EventTemplate, payouts: readonly Payout[]): readonly Payout[] {
  if (!Array.isArray(template.tags)) {
    return payouts;
  }
  const left = [...payouts];
  const ordered: Payout[] = [];
  for (const tag of template.tags) {
    const [name, caip19, address] = Array.isArray(tag) ? tag : [];
    const index = left.findIndex(
      (payout) =>
        name === 'accept' &&
        payout.caip19 === caip19 &&
        typeof address === 'string' &&
        sameAddress(payout.caip19, payout.address, address),
    );
    const [found] = index === -1 ? [] : left.splice(index, 1);
    if (found === undefined) {
      return payouts;
    }
    ordered.push(found);
  }
  return left.length === 0 ? ordered : payouts;
}

export interface MoveCheckInput {
  prepared: MoveTemplates;
  /** The payouts proven for O', as sent to prepare. */
  payouts: readonly Payout[];
  storePubkey: string;
  operator: string;
  localNow: number;
}

export type CheckedMove =
  | {
      ok: true;
      payto: EventTemplate;
      auth: EventTemplate;
      revocation: EventTemplate | undefined;
    }
  | { ok: false; message: string };

/** Every prepared template, when it is exactly what the page expects to be signed; else why not. */
export function checkMoveTemplates(input: MoveCheckInput): CheckedMove {
  const { prepared, storePubkey, operator, localNow } = input;
  const payto = checkOwnerTemplate({
    kind: 10133,
    template: prepared.payto,
    payouts: inTemplateOrder(prepared.payto, input.payouts),
    storePubkey,
    operator,
    localNow,
  });
  if (!payto.ok) {
    return { ok: false, message: TEMPLATE_PROBLEMS[payto.problem] };
  }
  const auth = checkOwnerTemplate({
    kind: 30490,
    template: prepared.auth,
    payouts: [],
    storePubkey,
    operator,
    localNow,
  });
  if (!auth.ok) {
    return { ok: false, message: TEMPLATE_PROBLEMS[auth.problem] };
  }
  const revocation = prepared.revocation ?? undefined;
  if (revocation !== undefined && badRevocation(revocation, storePubkey, localNow)) {
    return { ok: false, message: BAD_REVOCATION };
  }
  return {
    ok: true,
    payto: payto.template,
    auth: auth.template,
    revocation:
      revocation === undefined
        ? undefined
        : {
            kind: revocation.kind,
            content: revocation.content,
            created_at: revocation.created_at,
            tags: revocation.tags,
          },
  };
}

export interface MoveRunInput {
  api: MoveApi;
  view: StoreView;
  /** The payouts proven for O'. */
  payouts: Payout[];
  operator: string;
  localNow: () => number;
  /** O's signature. */
  signOld: (template: EventTemplate) => Promise<NostrEvent>;
  /** O'. */
  newOwner: Signer;
  /** A move sent before whose answer was lost: sent again as it is, not prepared again. */
  sent?: MoveInput;
}

export type MoveOutcome =
  /** `sent`: no answer came, so the move may have been taken; the next try sends it again. */
  | { ok: false; message: string; sent?: MoveInput }
  /** Moved: what came of the store's setup request, read by O' from now on. */
  | { ok: true; outcome: Exclude<CommitOutcome, { kind: 'refused' }> };

/** What the move's answer says of the store's setup request. */
export function moveOutcome(
  answer: MoveAnswer,
  pendingStore: boolean,
): Exclude<CommitOutcome, { kind: 'refused' }> {
  if (answer.alreadyMoved === true && typeof answer.requestId === 'string') {
    return pendingStore
      ? { kind: 'on_activation' }
      : { kind: 'follow', requestId: answer.requestId };
  }
  return requestOutcome(answer.request ?? undefined, pendingStore);
}

type Prepared = { ok: true; signed: MoveInput } | { ok: false; message: string };

/** Prepare, check every template, and sign: O' the payout list and authorization, O the revocation. */
async function prepareSigned(input: MoveRunInput): Promise<Prepared> {
  const { api, view, payouts, newOwner } = input;
  const to = newOwner.pubkey;
  let prepared: MoveTemplates;
  try {
    prepared = await api.prepareMove({ to, payouts });
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  const checked = checkMoveTemplates({
    prepared,
    payouts,
    storePubkey: view.storePubkey,
    operator: input.operator,
    localNow: input.localNow(),
  });
  if (!checked.ok) {
    return checked;
  }
  try {
    const payto = await newOwner.signEvent(checked.payto);
    const auth = await newOwner.signEvent(checked.auth);
    const revocation =
      checked.revocation === undefined ? undefined : await input.signOld(checked.revocation);
    return {
      ok: true,
      signed: { to, payto, auth, ...(revocation === undefined ? {} : { revocation }) },
    };
  } catch {
    return { ok: false, message: GENERIC_ERROR };
  }
}

type Sent =
  | { kind: 'moved'; outcome: Exclude<CommitOutcome, { kind: 'refused' }> }
  /** No answer could be read: the move may have been taken. */
  | { kind: 'unknown'; message: string }
  /** Refused, and a fresh prepare may fix it. */
  | { kind: 'again'; message: string }
  | { kind: 'refused'; message: string };

/** Whether a failed call may still have been taken by the server: no answer, or none readable. */
function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === 'network' || error.code === 'unexpected';
}

/** Send `signed`, with fresh authorizations by both keys. */
async function sendMove(input: MoveRunInput, signed: MoveInput): Promise<Sent> {
  try {
    const answer = await input.api.move(signed, input.newOwner);
    return { kind: 'moved', outcome: moveOutcome(answer, input.view.status === 'pending') };
  } catch (error) {
    const message = errorMessage(error);
    if (outcomeUnknown(error)) {
      return { kind: 'unknown', message };
    }
    return error instanceof ApiError && PREPARE_AGAIN_CODES.has(error.code)
      ? { kind: 'again', message }
      : { kind: 'refused', message };
  }
}

/**
 * Prepare, check, sign with both keys and move. A move whose answer was lost
 * is sent again as it was (the server answers `alreadyMoved` when it took
 * it), never prepared again: after a move, prepare is refused as `moved`.
 * A refusal a fresh prepare fixes is prepared again, once.
 */
export async function runMove(input: MoveRunInput): Promise<MoveOutcome> {
  let signed = input.sent;
  let preparedAgain = false;
  for (;;) {
    if (signed === undefined) {
      const prepared = await prepareSigned(input);
      if (!prepared.ok) {
        return prepared;
      }
      signed = prepared.signed;
    }
    let sent = await sendMove(input, signed);
    if (sent.kind === 'unknown') {
      sent = await sendMove(input, signed);
    }
    if (sent.kind === 'moved') {
      return { ok: true, outcome: sent.outcome };
    }
    if (sent.kind === 'unknown') {
      return { ok: false, message: sent.message, sent: signed };
    }
    if (sent.kind === 'again' && !preparedAgain) {
      preparedAgain = true;
      signed = undefined;
      continue;
    }
    return { ok: false, message: sent.message };
  }
}
