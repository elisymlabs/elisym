// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDLE_DOT,
  IDLE_STROKE,
  OTHER_DOTS,
  OTHER_STROKES,
  SERIES_DOTS,
  SERIES_FILLS,
  SERIES_STROKES,
  STATE_DOTS,
  STATE_FILLS,
} from '../src/lib/charts';

const CSS = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');

const BASE_TEXT = ['text', 'text-2', 'text-3'];

/** Text on a tinted background, each tint laid over the backgrounds it sits on. */
const PAIRS: { text: string; on: string; over: string[] }[] = [
  { text: 'error', on: 'bg', over: [] },
  { text: 'error', on: 'surface', over: [] },
  { text: 'warn', on: 'warn-bg', over: ['bg', 'surface'] },
  { text: 'text-2', on: 'warn-bg', over: ['bg'] },
  { text: 'green', on: 'green-bg', over: ['bg', 'surface'] },
  { text: 'blue', on: 'blue-bg', over: ['surface'] },
  { text: 'text-2', on: 'accent-soft', over: ['bg'] },
  { text: 'ink-text', on: 'ink', over: [] },
];

const BACKGROUNDS = ['bg', 'surface', 'surface-2'];

/** Classes in the chart sources that are not a chart's colors: surfaces, text, tints behind text. */
const NOT_GRAPHICS = [
  'none',
  'transparent',
  'surface',
  'surface-2',
  'text',
  'text-2',
  'accent-soft',
  'warn-bg',
];

/** Every color the charts fill or stroke with: the series, the neutral, the states. */
const CHART_COLORS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-idle',
  'warn',
  'green',
  'blue',
  'text-3',
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

  it('draws every chart color at 3:1 or better on the cards and the page, in both schemes', () => {
    for (const colors of found) {
      for (const series of CHART_COLORS) {
        for (const background of ['surface', 'bg']) {
          const ratio = contrast(named(colors, series), named(colors, background));
          expect(ratio, `${series} on ${background}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('covers every color the chart components draw with', () => {
    const files = ['DayBars', 'CreditedChart', 'OrdersDonut', 'StatusStrip'];
    const sources = [
      ...files.map((name) =>
        readFileSync(join(process.cwd(), `src/components/${name}.tsx`), 'utf8'),
      ),
      readFileSync(join(process.cwd(), 'src/lib/charts.ts'), 'utf8'),
    ].join('\n');
    // Fills, strokes and the legends' dots; an arbitrary value (`fill-[#...]`) is never allowed.
    const names = [...sources.matchAll(/\b(?:fill|stroke|bg)-(\[[^\]]*\]|[a-z][a-z0-9-]*)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(names.filter((name) => name.startsWith('['))).toEqual([]);
    const used = new Set(names.filter((name) => !NOT_GRAPHICS.includes(name)));
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) {
      expect(CHART_COLORS, name).toContain(name);
    }
  });

  it('marks the charts only with checked chart colors, never a surface or a line', () => {
    const marks = [
      ...SERIES_FILLS,
      ...SERIES_STROKES,
      ...SERIES_DOTS,
      IDLE_STROKE,
      IDLE_DOT,
      ...Object.values(OTHER_STROKES),
      ...Object.values(OTHER_DOTS),
      ...Object.values(STATE_FILLS),
      ...Object.values(STATE_DOTS),
    ];
    for (const mark of marks) {
      const name = mark.replace(/^(?:fill|stroke|bg)-/, '');
      expect(CHART_COLORS, mark).toContain(name);
    }
  });
});
