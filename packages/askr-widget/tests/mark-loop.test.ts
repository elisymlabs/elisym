// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MarkModule = typeof import('../src/ui/mark');
type FrameCallback = (now: number) => void;

const FRAME_MS = 1000 / 24;
const START_TIME = 2.2;
const DRIFT_SPEED = 0.18;

let queued: FrameCallback[] = [];
let still = false;
let changeListeners: Array<() => void> = [];

/** Run every frame the loop asked for, at `now`. */
function runFrames(now: number): void {
  const due = queued;
  queued = [];
  for (const callback of due) {
    callback(now);
  }
}

/** A fresh copy of the module: the loop's clock and its set of marks start over. */
async function freshMark(): Promise<MarkModule> {
  vi.resetModules();
  return import('../src/ui/mark');
}

function ringPath(svg: SVGSVGElement): string | null {
  return svg.querySelectorAll('path')[3]?.getAttribute('d') ?? null;
}

beforeEach(() => {
  queued = [];
  still = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
    queued.push(callback);
    return queued.length;
  });
  changeListeners = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('reduce') && still;
    },
    addEventListener: (_type: string, listener: () => void) => {
      changeListeners.push(listener);
    },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the mark loop', () => {
  it('redraws about 24 times a second, not on every frame', async () => {
    const { createMark } = await freshMark();
    const svg = createMark(document, 'mark');
    document.body.append(svg);
    const first = ringPath(svg);
    runFrames(FRAME_MS - 1);
    expect(ringPath(svg)).toBe(first);
    expect(queued).toHaveLength(1);
    runFrames(FRAME_MS + 1);
    expect(ringPath(svg)).not.toBe(first);
  });

  it('moves on by a few frames only after a long gap: a background tab never jumps', async () => {
    const { createMark, markPaths } = await freshMark();
    const svg = createMark(document, 'mark');
    document.body.append(svg);
    runFrames(100_000);
    const clamped = START_TIME + ((4 * FRAME_MS) / 1000) * DRIFT_SPEED;
    expect(ringPath(svg)).toBe(markPaths(clamped)[3]);
  });

  it('drops a mark taken out of the page and stops once none is left', async () => {
    const { createMark } = await freshMark();
    createMark(document, 'mark');
    expect(queued).toHaveLength(1);
    runFrames(100);
    expect(queued).toHaveLength(0);
  });

  it('starts again for a mark put back on the page', async () => {
    const { animateMark, createMark } = await freshMark();
    const svg = createMark(document, 'mark');
    runFrames(100);
    expect(queued).toHaveLength(0);
    document.body.append(svg);
    animateMark(svg);
    expect(queued).toHaveLength(1);
    const before = ringPath(svg);
    runFrames(200);
    expect(ringPath(svg)).not.toBe(before);
  });

  it('leaves a mark the visitor cannot see as it is, and keeps the loop for when it shows', async () => {
    const { createMark } = await freshMark();
    const svg = createMark(document, 'mark');
    document.body.append(svg);
    let visible = false;
    Object.defineProperty(svg, 'checkVisibility', { value: () => visible });
    const before = ringPath(svg);
    runFrames(100);
    expect(ringPath(svg)).toBe(before);
    expect(queued).toHaveLength(1);
    visible = true;
    runFrames(200);
    expect(ringPath(svg)).not.toBe(before);
  });

  it('stops drifting the moment the visitor asks for reduced motion', async () => {
    const { createMark } = await freshMark();
    const svg = createMark(document, 'mark');
    document.body.append(svg);
    runFrames(100);
    const moved = ringPath(svg);
    still = true;
    runFrames(200);
    expect(ringPath(svg)).toBe(moved);
    // The loop parks instead of spinning while the visitor wants things still.
    expect(queued).toHaveLength(0);
    still = false;
    for (const listener of changeListeners) {
      listener();
    }
    expect(queued).toHaveLength(1);
    runFrames(300);
    expect(ringPath(svg)).not.toBe(moved);
  });

  it('a change event while still asks for no frame', async () => {
    const { createMark } = await freshMark();
    const svg = createMark(document, 'mark');
    document.body.append(svg);
    still = true;
    runFrames(100);
    expect(queued).toHaveLength(0);
    for (const listener of changeListeners) {
      listener();
    }
    expect(queued).toHaveLength(0);
  });
});
