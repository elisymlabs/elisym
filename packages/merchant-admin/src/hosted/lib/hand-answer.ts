/**
 * A hand answer for an order with an unresolved payment: complete it, or
 * record the refund the merchant sent from their own wallet. The refund
 * amount is typed in the coin's units and sent as integer subunits, by the
 * coin's decimals.
 */
import { type AmountProblem, coinDecimals, toSubunits } from './amounts';
import { coinLabel } from './coins';
import type { HandInput, StoreView } from './types';

/** The server's bound on a refund transaction id. */
export const MAX_REFUND_TX = 200;

export const AMOUNT_PROBLEMS: Readonly<Record<AmountProblem, string>> = {
  format: 'Enter the refund amount as a number in the coin, such as 12 or 12.50.',
  negative: 'The refund amount cannot be negative.',
  zero: 'The refund amount must be above 0.',
  decimals: 'The refund amount has more decimals than this coin allows.',
  large: 'The refund amount is too large.',
};

export const NO_TX = 'Enter the transaction of the refund you sent.';
export const BAD_TX = 'The refund transaction is not valid. Paste it as one piece, with no spaces.';
export const NO_COIN = 'Choose the coin the refund was paid in.';

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
  const tx = form.tx.trim();
  if (tx === '') {
    return { ok: false, message: NO_TX };
  }
  if (tx.length > MAX_REFUND_TX || /\s/u.test(tx)) {
    return { ok: false, message: BAD_TX };
  }
  const decimals = coinDecimals(form.caip19);
  if (decimals === undefined) {
    return { ok: false, message: NO_COIN };
  }
  const amount = toSubunits(form.amount, decimals);
  if (!amount.ok) {
    return { ok: false, message: AMOUNT_PROBLEMS[amount.problem] };
  }
  return {
    ok: true,
    input: { kind: 'refunded', tx, amount: amount.subunits, asset: form.caip19 },
  };
}

/** The coins a refund may be in: the store's payouts (live first, then the draft), each once, known to the registry. */
export function refundCoins(view: StoreView): { caip19: string; label: string }[] {
  const ids = [...(view.activePayouts?.payouts ?? []), ...(view.config?.draftPayouts ?? [])].map(
    (payout) => payout.caip19,
  );
  return [...new Set(ids)].flatMap((caip19) => {
    const label = coinLabel(caip19);
    return label === undefined ? [] : [{ caip19, label }];
  });
}
