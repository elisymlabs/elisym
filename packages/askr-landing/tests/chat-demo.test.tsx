import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDemo } from '../src/components/ChatDemo';
import { NICHES } from '../src/niches';
import { WIDGET_TEXT } from '../src/widget-text';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * The demo's steps for the first niche's three turns, as ChatDemo times them: a pause (the
 * greeting, then a chip tapped), asked, thinking, answered, then its cards or comparison to read.
 */
const STEP_MS = [
  ...[900, 450, 1900, 160, 3400],
  ...[650, 450, 1900, 160, 3400],
  ...[650, 450, 1900, 160, 6500],
];

/** The log's content height, as a browser would measure it (happy-dom measures 0). */
const LOG_HEIGHT = 480;

/** An observer that reports every element it watches as on screen, at once. */
class OnScreen {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect(): void {}
  unobserve(): void {}
}

let root: Root | undefined;
let container: HTMLElement | undefined;
const scrollCalls: ScrollToOptions[] = [];
const topWrites: number[] = [];

function stubMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

async function render(onFinished?: () => void): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const niche = NICHES[0];
  if (niche === undefined) {
    throw new Error('no niche');
  }
  await act(async () => root?.render(<ChatDemo niche={niche} onFinished={onFinished} />));
  return container;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Everything is on screen at once.
  vi.stubGlobal('IntersectionObserver', OnScreen);
  scrollCalls.length = 0;
  topWrites.length = 0;
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function record(
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    if (this.classList.contains('wgt-log') && typeof options === 'object') {
      scrollCalls.push(options);
    }
  });
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
    function measure(this: Element) {
      return this.classList.contains('wgt-log') ? LOG_HEIGHT : 0;
    },
  );
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function record(
    this: Element,
    value: number,
  ) {
    if (this.classList.contains('wgt-log')) {
      topWrites.push(value);
    }
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the hero chat', () => {
  it('jumps to the newest message where the browser cannot glide', async () => {
    stubMotion(false);
    const prototypes = [HTMLElement.prototype, Element.prototype];
    const saved = prototypes.map((prototype) =>
      Object.getOwnPropertyDescriptor(prototype, 'scrollTo'),
    );
    try {
      for (const prototype of prototypes) {
        Reflect.deleteProperty(prototype, 'scrollTo');
      }
      await render();
      await advance(STEP_MS[0] ?? 0);
      expect(topWrites).toEqual([0, LOG_HEIGHT]);
      expect(scrollCalls).toEqual([]);
    } finally {
      prototypes.forEach((prototype, index) => {
        const descriptor = saved[index];
        if (descriptor !== undefined) {
          Object.defineProperty(prototype, 'scrollTo', descriptor);
        }
      });
    }
  });

  it('opens at the top, then glides to the newest message at every step', async () => {
    stubMotion(false);
    await render();
    expect(topWrites).toEqual([0]);
    expect(scrollCalls).toEqual([]);
    for (const [step, ms] of STEP_MS.slice(0, -1).entries()) {
      // Each step lasts exactly its time: not a moment shorter.
      await advance(ms - 1);
      expect(scrollCalls, `step ${step + 1} early`).toHaveLength(step);
      await advance(1);
      expect(scrollCalls, `step ${step + 1}`).toHaveLength(step + 1);
      expect(scrollCalls.at(-1), `step ${step + 1}`).toEqual({
        top: LOG_HEIGHT,
        behavior: 'smooth',
      });
    }
    expect(topWrites).toEqual([0]);
  });

  it('plays once and stays on the finished conversation, never starting over', async () => {
    stubMotion(false);
    const page = await render();
    for (const ms of STEP_MS) {
      await advance(ms);
    }
    await advance(60_000);
    expect(topWrites).toEqual([0]);
    expect(scrollCalls).toHaveLength(STEP_MS.length - 1);
    expect(page.querySelector('.wgt-cards')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('taps the chips the answers offer, one after another, ending on the comparison', async () => {
    stubMotion(false);
    const page = await render();
    const chipNodes = () => [...page.querySelectorAll('.wgt-chip')];
    const chips = () => chipNodes().map((chip) => chip.textContent);
    const pressed = () => page.querySelector('.wgt-chip-pressed')?.textContent;
    const asked = () => [...page.querySelectorAll('.wgt-mine')].map((bubble) => bubble.textContent);
    const answers = () => page.querySelectorAll('.wgt-theirs').length;
    const thinking = () => page.querySelector('.wgt-status')?.textContent === WIDGET_TEXT.thinking;
    const cards = () => page.querySelectorAll('.wgt-card').length;
    // The phases of one turn, from its pause: what each shows that the one before did not.
    const playTurn = async (from: number, before: { cards: number; answers: number }) => {
      // Asked: the question is out, nothing is thinking yet, the chips are gone.
      await advance(STEP_MS[from] ?? 0);
      expect(thinking()).toBe(false);
      expect(chips()).toEqual([]);
      expect(answers()).toBe(before.answers);
      // Thinking.
      await advance(STEP_MS[from + 1] ?? 0);
      expect(thinking()).toBe(true);
      expect(answers()).toBe(before.answers);
      // Answered: the answer lands with its chips, but its cards or table come a step later.
      await advance(STEP_MS[from + 2] ?? 0);
      expect(thinking()).toBe(false);
      expect(answers()).toBe(before.answers + 1);
      expect(chips().length).toBeGreaterThan(0);
      expect(cards()).toBe(before.cards);
      expect(page.querySelector('.wgt-table')).toBeNull();
      // Shown.
      await advance(STEP_MS[from + 3] ?? 0);
    };
    // The greeting is the only answer before the first question.
    expect(answers()).toBe(1);
    await playTurn(0, { cards: 0, answers: 1 });
    expect(chips()).toEqual(['Compare them', 'Anything cheaper?']);
    expect(pressed()).toBeUndefined();
    expect(cards()).toBe(2);
    const firstCompare = chipNodes()[0];
    // A chip is tapped: pressed, still under the answer, its question not out yet.
    await advance(STEP_MS[4] ?? 0);
    expect(pressed()).toBe('Anything cheaper?');
    expect(asked()).toHaveLength(1);
    await playTurn(5, { cards: 2, answers: 2 });
    expect(asked()).toEqual([NICHES[0]?.turns[0].question, 'Anything cheaper?']);
    expect(cards()).toBe(3);
    // The new answer's chips rise in anew, even the one it offered before (they left when the
    // question went out).
    expect(chips()).toEqual(['Compare them', 'Shipping time']);
    expect(chipNodes()[0]).not.toBe(firstCompare);
    await advance(STEP_MS[9] ?? 0);
    expect(pressed()).toBe('Compare them');
    expect(page.querySelector('.wgt-table')).toBeNull();
    await playTurn(10, { cards: 3, answers: 3 });
    expect(pressed()).toBeUndefined();
    const table = page.querySelector('.wgt-table');
    expect(table).not.toBeNull();
    const row = (selector: string) =>
      [...(table?.querySelectorAll(selector) ?? [])].map((cell) => cell.textContent);
    expect(row('thead th')).toEqual([
      '',
      'Aria ANC headphones',
      `Pulse Pro headphones${WIDGET_TEXT.recommended}`,
      'Stride sport earbuds',
    ]);
    // The store's price row first, then the assistant's rows, a cell per product in order.
    expect(row('tbody tr:nth-child(1) > *')).toEqual([
      'Price',
      '179.00 USD',
      '199.00 USD',
      '89.00 USD',
    ]);
    expect(row('tbody tr:nth-child(3) > *')).toEqual(['Battery', '32 h', '40 h', '6 h']);
    const label = page.querySelector('figure')?.getAttribute('aria-label') ?? '';
    expect(label).toContain(`A visitor asks: ${NICHES[0]?.turns[0].question}`);
    expect(label).toContain('A visitor taps: Anything cheaper?');
    expect(label).toContain('It shows Stride sport earbuds at 89.00 USD.');
    expect(label).toContain(
      'It compares Aria ANC headphones, Pulse Pro headphones, Stride sport earbuds side by side.',
    );
  });

  it('hands on only once the last answer has had its full time to be read', async () => {
    stubMotion(false);
    const finished = vi.fn();
    await render(finished);
    for (const ms of STEP_MS.slice(0, -1)) {
      await advance(ms);
    }
    await advance((STEP_MS.at(-1) ?? 0) - 1);
    expect(finished).not.toHaveBeenCalled();
    await advance(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('never glides for a visitor who asked for less motion', async () => {
    stubMotion(true);
    const page = await render();
    expect(scrollCalls).toEqual([]);
    expect(topWrites).toEqual([LOG_HEIGHT]);
    expect(page.querySelector('.wgt-cards')).not.toBeNull();
    expect(page.querySelector('.wgt-table')).not.toBeNull();
    expect(page.querySelector('.wgt-chip-pressed')).toBeNull();
    await advance(20_000);
    expect(scrollCalls).toEqual([]);
  });
});
