import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_GLYPH,
  RETURN_GLYPH,
  SOLANA_GLYPH,
  SOLANA_MARK_GRADIENT,
  SOLANA_MARK_PATH,
  STOP_GLYPH,
  TEMPO_GLYPH,
  TEMPO_MARK_PATH,
} from '../src/app/ui/glyphs';

const LOGOS = new URL('../src/app/ui/logos/', import.meta.url);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function decoded(uri: string): string {
  const prefix = 'data:image/svg+xml,';
  expect(uri.startsWith(prefix)).toBe(true);
  return decodeURIComponent(uri.slice(prefix.length));
}

describe('the bundled glyphs', () => {
  it('reference nothing outside themselves', () => {
    for (const uri of [SOLANA_GLYPH, TEMPO_GLYPH, CHECK_GLYPH, STOP_GLYPH, RETURN_GLYPH]) {
      const svg = decoded(uri);
      expect(svg).not.toMatch(/href/i);
      expect(svg).not.toMatch(/<image/i);
      expect(svg).not.toMatch(/<style|@import/i);
      expect(svg.replaceAll('url(#', '')).not.toContain('url(');
      expect(svg.replaceAll(SVG_NAMESPACE, '')).not.toMatch(/http/i);
    }
  });

  it('draw the official Solana and Tempo marks, as in their source files', () => {
    const solana = readFileSync(new URL('solana-logomark.svg', LOGOS), 'utf8');
    const tempo = readFileSync(new URL('tempo-logo.svg', LOGOS), 'utf8');
    expect(solana).toContain(`d="${SOLANA_MARK_PATH}"`);
    expect(tempo).toContain(`d="${TEMPO_MARK_PATH}"`);
    // The gradient's own coordinates and stops, under a renamed id.
    const stops = [...solana.matchAll(/<stop [^>]+\/>/g)].map((match) => match[0]);
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(SOLANA_MARK_GRADIENT).toContain(stop);
    }
    expect(SOLANA_MARK_GRADIENT).toContain('x1="8.52558" y1="90.0973"');
    expect(decoded(SOLANA_GLYPH)).toContain('viewBox="0 0 101 88"');
    expect(decoded(TEMPO_GLYPH)).toContain('viewBox="0 0 40 40"');
    expect(decoded(TEMPO_GLYPH)).toContain('fill="#fff"');
  });
});
