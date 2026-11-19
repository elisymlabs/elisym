import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDemo } from '../src/components/ChatDemo';
import { NICHES } from '../src/niches';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The demo's steps, as ChatDemo times them: greeting, asked, thinking, answered, cards. */
const STEP_MS = [900, 450, 1900, 160, 6500];

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

async function render(): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const niche = NICHES[0];
  if (niche === undefined) {
    throw new Error('no niche');
  }
  await act(async () => root?.render(<ChatDemo niche={niche} />));
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
      await advance(ms);
      expect(scrollCalls, `step ${step + 1}`).toHaveLength(step + 1);
      expect(scrollCalls.at(-1), `step ${step + 1}`).toEqual({
        top: LOG_HEIGHT,
        behavior: 'smooth',
      });
    }
    expect(topWrites).toEqual([0]);
  });

  it('jumps back to the top when the conversation starts over', async () => {
    stubMotion(false);
    await render();
    for (const ms of STEP_MS) {
      await advance(ms);
    }
    expect(topWrites).toEqual([0, 0]);
    expect(scrollCalls).toHaveLength(STEP_MS.length - 1);
  });

  it('never glides for a visitor who asked for less motion', async () => {
    stubMotion(true);
    const page = await render();
    expect(scrollCalls).toEqual([]);
    expect(topWrites).toEqual([LOG_HEIGHT]);
    expect(page.querySelector('.wgt-cards')).not.toBeNull();
    await advance(20_000);
    expect(scrollCalls).toEqual([]);
  });
});
