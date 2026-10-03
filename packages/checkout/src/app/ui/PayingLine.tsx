import type { Paying } from '../session';
import { ChainGlyph } from './ChainGlyph';
import { payingLine } from './text';

interface Props {
  paying: Paying | undefined;
}

/** The exact payment, read-only: it replaces the payout choice once a payment starts. */
export function PayingLine({ paying }: Props) {
  return paying === undefined ? null : (
    <p class="paying">
      <ChainGlyph chain={paying.chain} />
      <span>{payingLine(paying)}</span>
    </p>
  );
}
