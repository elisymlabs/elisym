/**
 * A hand answer for an order with an unresolved payment: complete it, or
 * record the refund the merchant sent from their own wallet. The refund
 * amount is typed in the coin's units and sent as integer subunits, by the
 * coin's decimals. Refunds are recorded on the rails merchant-node takes
 * them on (`hand.ts` `refundAsset`): Solana and Tempo, not yet the EIP-3009
 * chains (Base, Arbitrum, Ethereum).
 */
import { parseCaip19 } from '@elisym/commerce';
import { settlementOf } from '@elisym/pay-core';
import { isSignature } from '@solana/kit';
import { type AmountProblem, toSubunits } from './amounts';
import { coinLabel } from './coins';
import type { HandInput, StoreView } from './types';

export const AMOUNT_PROBLEMS: Readonly<Record<AmountProblem, string>> = {
  format: 'Enter the refund amount as a number in the coin, such as 12 or 12.50.',
  negative: 'The refund amount cannot be negative.',
  zero: 'The refund amount must be above 0.',
  decimals: 'The refund amount has more decimals than this coin allows.',
  large: 'The refund amount is too large.',
};

export const NO_TX = 'Enter the transaction of the refund you sent.';
export const BAD_SOLANA_TX =
  'This is not a Solana transaction signature. Paste the signature of the refund as one piece.';
export const BAD_TEMPO_TX =
  'This is not a Tempo transaction hash. Paste it as one piece: 0x and 64 hex characters.';
export const NO_COIN = 'Choose the coin the refund was paid in.';
export const EVM_REFUNDS_LATER = (labels: readonly string[]) =>
  `Refunds in ${labels.join(', ')} cannot be recorded here yet. Completing the order still works.`;

/** A Tempo transaction hash as the ledger keeps it (merchant-node `TEMPO_HASH_RE`). */
const TEMPO_HASH_RE = /^0x[0-9a-f]{64}$/;

type RefundRail = 'solana' | 'tempo';

/** The rail a refund in `caip19` is recorded on, or undefined when none takes it yet. */
function refundRail(caip19: string): { rail: RefundRail; decimals: number } | undefined {
  const parsed = parseCaip19(caip19);
  if (parsed === undefined) {
    return undefined;
  }
  const rail = settlementOf(parsed.chain);
  return rail === 'solana' || rail === 'tempo'
    ? { rail, decimals: parsed.asset.decimals }
    : undefined;
}

/** The refund transaction in the spelling its rail keeps, or undefined when it is not one of that rail. */
function refundTx(rail: RefundRail, typed: string): string | undefined {
  if (rail === 'tempo') {
    const hash = typed.toLowerCase();
    return TEMPO_HASH_RE.test(hash) ? hash : undefined;
  }
  try {
    return isSignature(typed) ? typed : undefined;
  } catch {
    // Characters outside base58 throw rather than answer false.
    return undefined;
  }
}

export interface HandForm {
  kind: 'complete' | 'refunded';
  tx: string;
  amount: string;
  caip19: string;
}

export type HandOutcome = { ok: true; input: HandInput } | { ok: false; message: string };

/** The hand answer to send, or why the form cannot be sent. */
export function handInput(form: HandForm): HandOutcome {
  if (form.kind === 'complete') {
    return { ok: true, input: { kind: 'complete' } };
  }
  const typed = form.tx.trim();
  if (typed === '') {
    return { ok: false, message: NO_TX };
  }
  const coin = refundRail(form.caip19);
  if (coin === undefined) {
    return { ok: false, message: NO_COIN };
  }
  const tx = refundTx(coin.rail, typed);
  if (tx === undefined) {
    return { ok: false, message: coin.rail === 'tempo' ? BAD_TEMPO_TX : BAD_SOLANA_TX };
  }
  const amount = toSubunits(form.amount, coin.decimals);
  if (!amount.ok) {
    return { ok: false, message: AMOUNT_PROBLEMS[amount.problem] };
  }
  return {
    ok: true,
    input: { kind: 'refunded', tx, amount: amount.subunits, asset: form.caip19 },
  };
}

function payoutCoins(view: StoreView): string[] {
  const ids = [...(view.activePayouts?.payouts ?? []), ...(view.config?.draftPayouts ?? [])].map(
    (payout) => payout.caip19,
  );
  return [...new Set(ids)];
}

/** The coins a refund may be recorded in: the store's payouts (live first, then the draft), each once, on a rail that takes refunds. */
export function refundCoins(view: StoreView): { caip19: string; label: string }[] {
  return payoutCoins(view).flatMap((caip19) => {
    const label = coinLabel(caip19);
    return label === undefined || refundRail(caip19) === undefined ? [] : [{ caip19, label }];
  });
}

/** The store's payout coins the registry knows whose refunds cannot be recorded yet (EIP-3009 chains). */
export function refundsLaterCoins(view: StoreView): string[] {
  return payoutCoins(view).flatMap((caip19) => {
    const label = coinLabel(caip19);
    return label === undefined || refundRail(caip19) !== undefined ? [] : [label];
  });
}
