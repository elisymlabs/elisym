// @vitest-environment happy-dom
import { buildConfigEvent, parseConfig } from '@elisym/askr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetView } from '../src/ui/element';
import { createMark, markPaths } from '../src/ui/mark';
import { makeStore, sign, testKey } from './fixtures';

const RIM: ReadonlyArray<readonly [number, number]> = [
  [50, 7],
  [5, 90],
  [95, 90],
];

/** Whether a point lies inside the rim triangle (the rounding only ever pulls inward). */
function insideRim(x: number, y: number): boolean {
  const [first, second, third] = RIM;
  if (!first || !second || !third) {
    return false;
  }
  const side = (from: readonly [number, number], to: readonly [number, number]): number =>
    (to[0] - from[0]) * (y - from[1]) - (to[1] - from[1]) * (x - from[0]);
  const signs = [side(first, second), side(second, third), side(third, first)];
  return signs.every((value) => value <= 0.001) || signs.every((value) => value >= -0.001);
}

/** The x/y points a ring path visits: its line and arc ends. */
function pathPoints(path: string): Array<[number, number]> {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
  const points: Array<[number, number]> = [];
  const commands = path.split(/(?=[MLA])/u);
  for (const command of commands) {
    const values = [...command.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
    const x = values[values.length - 2];
    const y = values[values.length - 1];
    if (x !== undefined && y !== undefined) {
      points.push([x, y]);
    }
  }
  expect(numbers.length).toBeGreaterThan(0);
  return points;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the Askr mark', () => {
  it('is the rim and six rings, every ring inside the rim, wherever the viewer drifts', () => {
    for (let time = 0; time < 60; time += 0.7) {
      const paths = markPaths(time);
      expect(paths).toHaveLength(7);
      for (const path of paths.slice(1)) {
        for (const [x, y] of pathPoints(path)) {
          expect(insideRim(x, y)).toBe(true);
        }
      }
    }
  });

  it('keeps its rim still and moves the rings as the viewer drifts', () => {
    const early = markPaths(1);
    const later = markPaths(4);
    expect(later[0]).toBe(early[0]);
    expect(later[3]).not.toBe(early[3]);
  });

  it('draws at once, hidden from assistive technology, alternating ink and paper', () => {
    const svg = createMark(document, 'mark launcher-mark');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('class')).toBe('mark launcher-mark');
    const paths = [...svg.querySelectorAll('path')];
    expect(paths.map((path) => path.getAttribute('class'))).toEqual([
      'mark-ink',
      'mark-paper',
      'mark-ink',
      'mark-paper',
      'mark-ink',
      'mark-paper',
      'mark-ink',
    ]);
    expect(paths.every((path) => (path.getAttribute('d') ?? '').startsWith('M'))).toBe(true);
  });
});

describe('the mark in the widget', () => {
  function view(): WidgetView {
    return new WidgetView(
      document,
      () => undefined,
      () => undefined,
    );
  }

  it('is the chat button with an "Ask AI" label, no emoji, named for a screen reader', () => {
    const { launcher } = view();
    expect(launcher.querySelector('svg.launcher-mark')).not.toBeNull();
    expect(launcher.querySelector('.launcher-label')?.textContent).toBe('Ask AI');
    expect(launcher.getAttribute('aria-label')).toBe('Chat with the store assistant');
  });

  it('stands in the header until the assistant has an avatar', () => {
    const widget = view();
    const mark = widget.panel.querySelector('.header-mark');
    expect(mark?.classList.contains('mark-off')).toBe(false);
  });

  it('steps aside once the assistant has an avatar', () => {
    const widget = view();
    const key = testKey();
    const config = parseConfig(
      sign(
        buildConfigEvent(
          { ...makeStore().configInput, avatar: 'https://cdn.example/ava.png' },
          key.secretKey,
        ),
        key,
      ),
    );
    if (!config) {
      throw new Error('no config');
    }
    widget.update({ phase: 'ready', branding: true, turns: [], config });
    expect(widget.panel.querySelector('.header-mark')?.classList.contains('mark-off')).toBe(true);
    expect(widget.panel.querySelector<HTMLImageElement>('.avatar')?.hidden).toBe(false);
  });

  it('turns beside the status while the assistant is thinking', () => {
    const widget = view();
    widget.update({
      phase: 'waiting',
      branding: true,
      inFlightAskId: 'a1',
      turns: [{ askId: 'a1', askedAt: 0, text: 'Tents?', status: 'Looking through tents' }],
    });
    const status = widget.panel.querySelector('.status');
    expect(status?.querySelector('svg.status-mark')).not.toBeNull();
    expect(status?.textContent).toBe('Looking through tents');
    const first = status?.querySelector('svg.status-mark');
    widget.update({
      phase: 'waiting',
      branding: true,
      inFlightAskId: 'a1',
      turns: [{ askId: 'a1', askedAt: 0, text: 'Tents?', status: 'Comparing weight' }],
    });
    // One mark for the status, re-used: a stream of updates never piles marks up.
    expect(status?.querySelector('svg.status-mark')).toBe(first);
    widget.update({ phase: 'ready', branding: true, turns: [] });
    expect(status?.querySelector('svg.status-mark')).toBeNull();
  });
});
