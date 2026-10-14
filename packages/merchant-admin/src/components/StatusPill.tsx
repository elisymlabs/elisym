import { type OrderState, STATE_LABELS } from '../lib/core';
import { STATE_SHORT, STATE_TONE } from '../lib/orders';

interface Props {
  state: OrderState;
}

export function StatusPill({ state }: Props) {
  return (
    <span
      title={STATE_LABELS[state]}
      className={`text-12 inline-flex items-center gap-6 rounded-full px-8 py-2 font-medium whitespace-nowrap ${STATE_TONE[state]}`}
    >
      <span aria-hidden="true" className="size-6 rounded-full bg-current" />
      {STATE_SHORT[state]}
    </span>
  );
}
