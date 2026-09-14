/**
 * The verifier's internal control flow. Every stage throws this and only this;
 * `verifyOnchainCall` catches it and turns it into the `{ ok: false }` result
 * both clients render. Nothing else escapes the verifier as an exception.
 */

import type { OnchainCallFacts, OnchainRefusalReason } from './types';

export class OnchainRefusalError extends Error {
  readonly reason: OnchainRefusalReason;
  /** Whatever was already derived when the refusal happened. */
  readonly facts?: Partial<OnchainCallFacts>;

  constructor(reason: OnchainRefusalReason, detail: string, facts?: Partial<OnchainCallFacts>) {
    super(detail);
    this.name = 'OnchainRefusalError';
    this.reason = reason;
    this.facts = facts;
  }
}

/**
 * Throw a refusal. Exists so call sites read as one line at the point of the
 * check. Facts are attached by `verifyOnchainCall` re-throwing, not here: only
 * it holds enough of them to be worth showing.
 */
export function refuse(reason: OnchainRefusalReason, detail: string): never {
  throw new OnchainRefusalError(reason, detail);
}

/**
 * The most informative string a thrown error carries, IN EVERY BUILD.
 *
 * `@solana/errors` composes its message from a catalog it drops whenever
 * `process.env.NODE_ENV === 'production'` - which is every shipped build,
 * including the browser bundle this SDK is compiled into. What a customer would
 * otherwise be shown is
 * `Solana error #3230004; Decode this error by running \`npx @solana/errors
 * decode -- ...\``, with the node's own words and the offending address
 * surviving only inside `context` - which is why nothing here may reason about
 * a kit error by matching its message.
 *
 * `__serverMessage` is the node's verbatim text, preserved in `context` for
 * every JSON-RPC error whose catalog entry interpolates it. Read first, because
 * on a real node it is the sentence worth showing.
 */
export function describeError(error: unknown): string {
  const context = (error as { context?: Record<string, unknown> } | null)?.context;
  const serverMessage = context?.__serverMessage;
  if (typeof serverMessage === 'string' && serverMessage.length > 0) {
    return serverMessage;
  }
  // A kit error that is NOT a JSON-RPC one - every codec, decompile and compile
  // failure - has no `__serverMessage`, and falling through to `error.message`
  // hands the customer the decode-advice blob this function exists to avoid.
  // Composed from `context` instead, which survives every build.
  //
  // Composed in EVERY build, including one where kit's human sentence exists.
  // It carries the same facts plus the decodable code, and the whole lesson of
  // the round that added this function is that a developer seeing a different
  // string from a customer is how a dead gate stayed hidden for two rounds.
  //
  // Detected by SHAPE rather than by `isSolanaError`: bun's isolated layout
  // can resolve more than one copy of `@solana/errors`, and an `instanceof`
  // across two copies is false for an error that is plainly one of them.
  if (context !== undefined && typeof context['__code'] === 'number') {
    return describeSolanaError(context);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * A kit error read out of its context: the code, plus whatever else the error
 * carried. `npx @solana/errors decode` turns the code into the full sentence,
 * and the context entries are what make one instance different from another -
 * which index was out of range, which address was missing.
 */
function describeSolanaError(context: Record<string, unknown>): string {
  const details = Object.entries(context)
    .filter(([key]) => key !== '__code')
    .map(([key, value]) => `${key}: ${formatContextValue(value)}`);
  const code = `Solana error #${String(context['__code'])}`;
  return details.length === 0 ? code : `${code} (${details.join(', ')})`;
}

function formatContextValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ');
  }
  return String(value);
}
