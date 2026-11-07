// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');

const BASE_TEXT = ['text', 'text-2', 'text-3'];

/** Text on a tinted background, each tint laid over the backgrounds it sits on. */
const PAIRS: { text: string; on: string; over: string[] }[] = [
  { text: 'accent-ink', on: 'bg', over: [] },
  { text: 'accent-ink', on: 'surface', over: [] },
  { text: 'accent-ink', on: 'surface-2', over: [] },
  { text: 'accent-text', on: 'accent', over: [] },
  // The Recommended badge: text on the accent tint, over the page.
  { text: 'accent-ink', on: 'accent-soft', over: ['bg'] },
];

const BACKGROUNDS = ['bg', 'surface', 'surface-2'];

/** An sRGB color with its alpha, channels 0-255. */
interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseColor(value: string): Color | undefined {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex !== null) {
    const [, red = '', green = '', blue = ''] = hex;
    return {
      red: Number.parseInt(red, 16),
      green: Number.parseInt(green, 16),
      blue: Number.parseInt(blue, 16),
      alpha: 1,
    };
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (rgb !== null) {
    const [, red = '', green = '', blue = '', alpha = ''] = rgb;
    return { red: Number(red), green: Number(green), blue: Number(blue), alpha: Number(alpha) };
  }
  return undefined;
}

/** The color variables of each scheme: the page's own, and the other one under its media query. */
function schemes(): Map<string, Color>[] {
  const [base = '', other = ''] = CSS.split('@media (prefers-color-scheme');
  const read = (part: string) =>
    new Map(
      [...part.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].flatMap((match) => {
        const color = parseColor((match[2] ?? '').trim());
        return color === undefined ? [] : [[match[1] ?? '', color] as const];
      }),
    );
  return [read(base), read(other.split('@theme')[0] ?? '')];
}

/** A translucent color laid over an opaque one. */
function over(top: Color, bottom: Color): Color {
  const mix = (upper: number, lower: number) => upper * top.alpha + lower * (1 - top.alpha);
  return {
    red: mix(top.red, bottom.red),
    green: mix(top.green, bottom.green),
    blue: mix(top.blue, bottom.blue),
    alpha: 1,
  };
}

/** WCAG relative luminance. */
function luminance(color: Color): number {
  const [red = 0, green = 0, blue = 0] = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: Color, second: Color): number {
  const [light = 0, dark = 0] = [luminance(first), luminance(second)].sort(
    (left, right) => right - left,
  );
  return (light + 0.05) / (dark + 0.05);
}

function named(colors: Map<string, Color>, name: string): Color {
  const color = colors.get(name);
  if (color === undefined) {
    throw new Error(`no color --${name}`);
  }
  return color;
}

describe('the text colors', () => {
  const found = schemes();

  it('reads both schemes from app.css', () => {
    expect(found).toHaveLength(2);
    for (const colors of found) {
      expect(colors.size).toBeGreaterThan(5);
    }
  });

  it('read at 4.5:1 or better, plain and on every tint, in both schemes', () => {
    for (const colors of found) {
      for (const text of BASE_TEXT) {
        for (const background of BACKGROUNDS) {
          const ratio = contrast(named(colors, text), named(colors, background));
          expect(ratio, `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const pair of PAIRS) {
        const tint = named(colors, pair.on);
        const grounds =
          pair.over.length === 0
            ? [tint]
            : pair.over.map((name) => over(tint, named(colors, name)));
        for (const ground of grounds) {
          const ratio = contrast(named(colors, pair.text), ground);
          expect(ratio, `${pair.text} on ${pair.on}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
