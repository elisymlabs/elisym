import type { ChainSlug } from '@elisym/pay-core';
import { ARBITRUM_GLYPH, BASE_GLYPH, ETHEREUM_GLYPH, SOLANA_GLYPH, TEMPO_GLYPH } from './glyphs';

interface Props {
  chain: ChainSlug;
}

const GLYPHS: Record<ChainSlug, string> = {
  solana: SOLANA_GLYPH,
  tempo: TEMPO_GLYPH,
  ethereum: ETHEREUM_GLYPH,
  arbitrum: ARBITRUM_GLYPH,
  base: BASE_GLYPH,
};

export function ChainGlyph({ chain }: Props) {
  return <img class="glyph" src={GLYPHS[chain]} alt="" aria-hidden="true" />;
}
