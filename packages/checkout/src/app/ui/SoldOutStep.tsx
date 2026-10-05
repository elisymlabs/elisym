import { EndedStep } from './EndedStep';
import { SOLD_OUT_GLYPH } from './glyphs';
import { REFUSALS, SOLD_OUT_PAID_LINE } from './text';

/**
 * A stopped product: information, not a warning, and never the store's own
 * words. The same on the first screen and in the session, with or without an
 * order of this buyer, so it tells nothing about one.
 */
export function SoldOutStep() {
  return (
    <EndedStep glyph={SOLD_OUT_GLYPH} title="Sold out">
      <p>{REFUSALS.sold_out}</p>
      <p class="note">{SOLD_OUT_PAID_LINE}</p>
    </EndedStep>
  );
}
