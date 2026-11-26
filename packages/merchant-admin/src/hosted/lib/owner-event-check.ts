/**
 * A13: what hosted mode checks in a template the server prepared before O
 * signs it. The server builds the owner events, so a breached or buggy server
 * could hand over one that outlives it: a far-future payout list no later one
 * could replace, an authorization for another store or operator, one with an
 * expiry. Only the exact expected shape is signed; anything else is refused
 * with a fixed reason. Pure (no DOM, no wallets): PayCore's server tests run
 * it against the templates the real server builds.
 */
import type { EventTemplate } from 'nostr-tools';
import type { OwnerEventKind, Payout } from './types';

export const KIND_PAYOUT_LIST = 10133;
export const KIND_AUTHORIZATION = 30490;
/** A template may be dated at most this far past the local clock; a past date is fine. */
export const MAX_AHEAD_SECS = 10 * 60;

export type TemplateProblem =
  /** Not an event template at all. */
  | 'malformed'
  | 'kind'
  | 'content'
  | 'date'
  /** The payout list's `accept` tags are not the payout rows, in order. */
  | 'payouts'
  /** A tag the expected shape does not have, or one missing. */
  | 'tags'
  /** The authorization names another store key. */
  | 'store'
  /** The authorization names another operator, or not hosted mode. */
  | 'operator';

export interface TemplateCheckInput {
  kind: OwnerEventKind;
  template: unknown;
  /** The payout rows the page holds: the payout list must be exactly these. */
  payouts: readonly Payout[];
  /** The store key the authorization must name, hex. */
  storePubkey: string;
  /** The committed operator (`PAYCORE_OPERATOR`). */
  operator: string;
  /** Local time, seconds. */
  localNow: number;
}

export type TemplateCheck =
  | { ok: true; template: EventTemplate }
  | { ok: false; problem: TemplateProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))
  );
}

/** How a payout address is compared: exactly (Solana base58 is case-sensitive), or lowercase (EVM, Tempo). */
export function sameAddress(caip19: string, left: string, right: string): boolean {
  return caip19.startsWith('eip155:') ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameTag(tag: readonly string[], expected: readonly string[]): boolean {
  return tag.length === expected.length && tag.every((item, index) => item === expected[index]);
}

function payoutListProblem(
  tags: string[][],
  payouts: readonly Payout[],
): TemplateProblem | undefined {
  if (tags.some((tag) => tag[0] !== 'accept')) {
    return 'tags';
  }
  if (tags.length !== payouts.length) {
    return 'payouts';
  }
  const differs = tags.some((tag, index) => {
    const payout = payouts[index];
    if (payout === undefined) {
      return true;
    }
    const [, caip19, address, signature, ...rest] = tag;
    return (
      rest.length > 0 ||
      caip19 !== payout.caip19 ||
      address === undefined ||
      !sameAddress(payout.caip19, address, payout.address) ||
      signature !== payout.signature
    );
  });
  return differs ? 'payouts' : undefined;
}

function authorizationProblem(
  tags: string[][],
  storePubkey: string,
  operator: string,
): TemplateProblem | undefined {
  if (tags.length !== 3) {
    return 'tags';
  }
  const [d, p, mode] = tags;
  if (d === undefined || p === undefined || mode === undefined) {
    return 'tags';
  }
  if (d[0] !== 'd' || p[0] !== 'p' || mode[0] !== 'mode') {
    return 'tags';
  }
  if (!sameTag(d, ['d', storePubkey]) || !sameTag(p, ['p', storePubkey])) {
    return 'store';
  }
  return sameTag(mode, ['mode', 'hosted', operator]) ? undefined : 'operator';
}

/** The template, when it is exactly what the page expects O to sign; else why not. */
export function checkOwnerTemplate(input: TemplateCheckInput): TemplateCheck {
  const { template } = input;
  if (
    !isRecord(template) ||
    typeof template.kind !== 'number' ||
    typeof template.content !== 'string' ||
    typeof template.created_at !== 'number' ||
    !Number.isSafeInteger(template.created_at) ||
    template.created_at < 0 ||
    !isTags(template.tags)
  ) {
    return { ok: false, problem: 'malformed' };
  }
  const { kind, content, created_at: createdAt, tags } = template;
  if (kind !== input.kind) {
    return { ok: false, problem: 'kind' };
  }
  if (content !== '') {
    return { ok: false, problem: 'content' };
  }
  if (createdAt > input.localNow + MAX_AHEAD_SECS) {
    return { ok: false, problem: 'date' };
  }
  const problem =
    kind === KIND_PAYOUT_LIST
      ? payoutListProblem(tags, input.payouts)
      : authorizationProblem(tags, input.storePubkey, input.operator);
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  return { ok: true, template: { kind, content, created_at: createdAt, tags } };
}
