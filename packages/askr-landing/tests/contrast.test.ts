// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');

/** Text colors and the backgrounds each one is set on. */
const PAIRS: { text: string; on: string[] }[] = [
  { text: 'text', on: ['bg', 'surface', 'surface-2'] },
  { text: 'text-2', on: ['bg', 'surface', 'surface-2'] },
  { text: 'text-3', on: ['bg', 'surface', 'surface-2'] },
  { text: 'accent-ink', on: ['bg', 'surface', 'surface-2'] },
  { text: 'accent-text', on: ['accent'] },
  { text: 'on-ink', on: ['ink', 'ink-2', 'accent'] },
  { text: 'on-ink-2', on: ['ink', 'ink-2'] },
  { text: 'on-ink-accent', on: ['ink', 'ink-2'] },
  { text: 'ink', on: ['on-ink-accent', 'on-ink'] },
];

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

/** The page's one scheme: the color variables of its `:root`. */
function scheme(): Map<string, Color> {
  const root = CSS.split(':root {')[1]?.split('}')[0] ?? '';
  return new Map(
    [...root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].flatMap((match) => {
      const color = parseColor((match[2] ?? '').trim());
      return color === undefined ? [] : [[match[1] ?? '', color] as const];
    }),
  );
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
  const colors = scheme();

  it('reads the scheme from app.css', () => {
    expect(colors.size).toBeGreaterThan(10);
  });

  it('read at 4.5:1 or better on every background they are set on', () => {
    for (const pair of PAIRS) {
      for (const background of pair.on) {
        const ratio = contrast(named(colors, pair.text), named(colors, background));
        expect(ratio, `${pair.text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
