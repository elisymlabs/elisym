import type { PricedPayout } from '@elisym/commerce/buyer';
import { payoutPaying } from '../session';
import { ChainGlyph } from './ChainGlyph';
import { payoutLabel } from './text';

interface Props {
  payouts: readonly PricedPayout[];
  selected: number;
  onChoose(index: number): void;
}

/** One chip per payout this widget can pay; the network is part of every label. */
export function PayoutChips({ payouts, selected, onChoose }: Props) {
  return (
    <div class="chips" role="radiogroup" aria-label="Pay with">
      {payouts.map((payout, index) => {
        const paying = payoutPaying(payout);
        return (
          <button
            type="button"
            role="radio"
            class="payout-chip"
            aria-checked={index === selected}
            key={`${payout.target.caip19.id} ${payout.target.address}`}
            onClick={() => onChoose(index)}
          >
            <ChainGlyph chain={paying.chain} />
            <span>{payoutLabel(paying)}</span>
          </button>
        );
      })}
    </div>
  );
}
