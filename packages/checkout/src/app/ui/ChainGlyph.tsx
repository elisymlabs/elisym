import type { Rail } from '../session';
import { SOLANA_GLYPH, TEMPO_GLYPH } from './glyphs';

interface Props {
  chain: Rail;
}

export function ChainGlyph({ chain }: Props) {
  return (
    <img
      class="glyph"
      src={chain === 'tempo' ? TEMPO_GLYPH : SOLANA_GLYPH}
      alt=""
      aria-hidden="true"
    />
  );
}
