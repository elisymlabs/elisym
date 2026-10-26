import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARBITRUM_GLYPH,
  ARBITRUM_MARK,
  BASE_MARK,
  BASE_GLYPH,
  CHECK_GLYPH,
  ETHEREUM_GLYPH,
  ETHEREUM_MARK,
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
    for (const uri of [
      SOLANA_GLYPH,
      TEMPO_GLYPH,
      ETHEREUM_GLYPH,
      ARBITRUM_GLYPH,
      BASE_GLYPH,
      CHECK_GLYPH,
      STOP_GLYPH,
      RETURN_GLYPH,
    ]) {
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

  it('draws the official Ethereum, Arbitrum and Base marks, exactly as in their source files', () => {
    // Each file's own frame and shapes: the glyph draws exactly those.
    const logo = (file: string) => {
      const text = readFileSync(new URL(file, LOGOS), 'utf8');
      const root = /<svg([^>]*)>([\s\S]*)<\/svg>/.exec(text);
      return { viewBox: /viewBox="([^"]*)"/.exec(root?.[1] ?? '')?.[1], shapes: root?.[2] };
    };
    const ethereum = logo('ethereum-diamond.svg');
    const arbitrum = logo('arbitrum-logomark.svg');
    const base = logo('base-square.svg');
    expect(ethereum.shapes).toBe(ETHEREUM_MARK);
    expect(arbitrum.shapes).toBe(ARBITRUM_MARK);
    expect(base.shapes).toBe(BASE_MARK);
    const tile = (body: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
    expect(decoded(ETHEREUM_GLYPH)).toBe(
      tile(
        `<circle cx="12" cy="12" r="12" fill="#fff"/><svg x="2" y="2" width="20" height="20" viewBox="${ethereum.viewBox}">${ETHEREUM_MARK}</svg>`,
      ),
    );
    expect(decoded(ARBITRUM_GLYPH)).toBe(
      tile(
        `<svg x="0" y="0" width="24" height="24" viewBox="${arbitrum.viewBox}">${ARBITRUM_MARK}</svg>`,
      ),
    );
    expect(decoded(BASE_GLYPH)).toBe(
      tile(`<svg x="2" y="2" width="20" height="20" viewBox="${base.viewBox}">${BASE_MARK}</svg>`),
    );
  });
});
