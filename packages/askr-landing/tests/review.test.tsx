import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AdminWindow } from '../src/components/AdminWindow';
import { CatalogFlow } from '../src/components/CatalogFlow';
import { ChatDemo } from '../src/components/ChatDemo';
import { Closing } from '../src/components/Closing';
import { CopyButton } from '../src/components/CopyButton';
import { Hero } from '../src/components/Hero';
import { LiveMark } from '../src/components/LiveMark';
import { ScrollWords } from '../src/components/ScrollWords';
import { ADMIN_URL } from '../src/constants';
import { NICHES } from '../src/niches';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGES = join(process.cwd(), '..');

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
}

function read(path: string): string {
  return readFileSync(join(PACKAGES, path), 'utf8');
}

/** Reduced motion on or off. */
function stubMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query === '(prefers-reduced-motion: reduce)',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

/** An observer that reports everything on screen at once, and counts what stays watched. */
class OnScreen {
  static watching = 0;
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    OnScreen.watching += 1;
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect(): void {
    OnScreen.watching = 0;
  }
  unobserve(): void {}
}

beforeEach(() => {
  OnScreen.watching = 0;
  vi.stubGlobal('IntersectionObserver', OnScreen);
});

afterEach(async () => {
  await unmount();
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the layout', () => {
  it('lets the hero, the abilities and the catalog shrink to a phone, never wider than the screen', () => {
    const hero = readFileSync(join(process.cwd(), 'src/components/Hero.tsx'), 'utf8');
    const sources = readFileSync(join(process.cwd(), 'src/components/Sources.tsx'), 'utf8');
    expect(hero).toContain('grid-cols-[minmax(0,1fr)]');
    expect(sources).toContain('grid-cols-[minmax(0,1fr)]');
    const features = readFileSync(join(process.cwd(), 'src/components/Features.tsx'), 'utf8');
    expect(features).toContain('grid-cols-[minmax(0,1fr)]');
  });
});

describe('the hero', () => {
  function tabs(page: HTMLElement): HTMLButtonElement[] {
    return [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  }

  it('moves between stores with the arrow keys, Home and End, one tab stop', async () => {
    stubMotion(true);
    const page = await render(<Hero />);
    const list = page.querySelector('[role="tablist"]');
    const press = async (key: string) => {
      await act(async () => {
        list?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };
    expect(tabs(page).map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    await press('ArrowRight');
    expect(tabs(page)[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs(page)[1]);
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(tabs(page)[NICHES.length - 1]?.getAttribute('aria-selected')).toBe('true');
    await press('Home');
    expect(tabs(page)[0]?.getAttribute('aria-selected')).toBe('true');
    await press('End');
    expect(tabs(page).map((tab) => tab.tabIndex)).toEqual([-1, -1, -1, 0]);
    expect(tabs(page).filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(
      1,
    );
  });

  it('turns to the next store after each conversation, until a store is chosen or it is paused', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const page = await render(<Hero />);
    const selected = () =>
      tabs(page).findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    // One conversation, step by step, so each step's timer is set before the next tick.
    const playThrough = async () => {
      for (let second = 0; second < 12; second += 1) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
      }
    };
    await playThrough();
    expect(selected()).toBe(1);
    const pause = page.querySelector<HTMLButtonElement>('button[aria-pressed]');
    expect(pause?.textContent).toBe('Pause');
    await act(async () => pause?.click());
    await playThrough();
    await playThrough();
    expect(selected()).toBe(1);
    await act(async () => pause?.click());
    await playThrough();
    expect(selected()).toBe(2);
    await act(async () => tabs(page)[0]?.click());
    expect(page.querySelector('button[aria-pressed]')).toBeNull();
    await playThrough();
    await playThrough();
    expect(selected()).toBe(0);
  });

  it('gives only the shown photo its alt text, and hides the chat drawing behind its label', async () => {
    stubMotion(true);
    const page = await render(<Hero />);
    const photos = [...page.querySelectorAll('img')].filter((image) =>
      NICHES.some((niche) => niche.photo.src === image.getAttribute('src')),
    );
    expect(photos.filter((image) => image.alt !== '')).toHaveLength(1);
    expect(photos[0]?.alt).toBe(NICHES[0]?.photo.alt);
    expect(page.querySelector('#niche-demo figure')?.getAttribute('aria-label')).toContain(
      NICHES[0]?.store ?? '',
    );
    expect(page.querySelector('#niche-demo .wgt-panel')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the copy', () => {
  it('claims no comparison wider than the product allows', async () => {
    expect(read('askr/src/constants.ts')).toMatch(/MAX_COMPARISON: 4,/);
    const page = await render(<App />);
    const text = page.textContent ?? '';
    expect(text).toContain('Two to four products, row by row');
    expect(text).not.toMatch(/\b(five|six|seven|eight|nine|ten) (products|laptops|headphones)\b/i);
  });

  it('says what the owner key signs, as the docs do, and that chats do not move with a new key', async () => {
    const overview = read('docs/pages/askr/overview.mdx');
    expect(overview).toContain('Chats that were open start afresh');
    const page = await render(<App />);
    const trust = page.querySelector('#trust')?.textContent ?? '';
    expect(trust).toContain('which keys may publish your products, are signed with a secret key');
    expect(trust).not.toMatch(/products, policies and settings are signed/i);
    expect(trust).toContain('with its products and plan.');
    expect(trust).not.toMatch(/plan and chats/);
    expect(trust).toContain('24 hours');
  });

  it('says it never takes payments, and that every store is activated on its plan', async () => {
    const page = await render(<App />);
    expect(page.querySelector('#faq')?.textContent).toContain('never touches money');
    expect(page.querySelector('#start')?.textContent).toContain('Free included');
    expect(page.querySelector('#pricing')?.textContent).toContain('Free included');
  });

  it('draws the admin on its own address, with its usage written as the admin writes it', async () => {
    const page = await render(<AdminWindow />);
    const address = new URL(ADMIN_URL);
    expect(page.textContent).toContain(`${address.host}${address.pathname.replace(/\/$/, '')}`);
    expect(page.textContent).toContain('(23.6%)');
    expect(page.textContent).toContain('(64.1%)');
  });
});

describe('motion', () => {
  it('keeps the mark still under reduced motion, and stops its frames when it leaves', async () => {
    stubMotion(true);
    const frame = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', frame);
    await render(<LiveMark />);
    expect(frame).not.toHaveBeenCalled();
    await unmount();
    stubMotion(false);
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    await render(<LiveMark />);
    expect(frame).toHaveBeenCalled();
    await unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('lights every word at once under reduced motion, and drops its scroll listener when it leaves', async () => {
    stubMotion(true);
    const page = await render(<ScrollWords text="one two three" coda="four" />);
    const words = [...page.querySelectorAll('.lit-word')];
    expect(words.map((word) => word.getAttribute('data-lit'))).toEqual([
      'true',
      'true',
      'true',
      'true',
    ]);
    await unmount();
    stubMotion(false);
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    await render(<ScrollWords text="one two" />);
    const scroll = added.mock.calls.find(([type]) => type === 'scroll')?.[1];
    expect(scroll).toBeDefined();
    await unmount();
    expect(
      removed.mock.calls.some(([type, listener]) => type === 'scroll' && listener === scroll),
    ).toBe(true);
  });

  it('shows the closing call at once under reduced motion, and keeps it reachable by keyboard', async () => {
    stubMotion(true);
    const page = await render(<Closing />);
    const outro = page.querySelector<HTMLElement>('#closing .on-ink-focus');
    expect(outro?.style.opacity).toBe('1');
    expect(outro?.style.visibility).not.toBe('hidden');
    await unmount();
    stubMotion(false);
    const scrolled = await render(<Closing />);
    const hidden = scrolled.querySelector<HTMLElement>('#closing .on-ink-focus');
    expect(hidden?.style.visibility).not.toBe('hidden');
    const link = hidden?.querySelector('a');
    await act(async () => {
      link?.focus();
      link?.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      hidden?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(hidden?.style.opacity).toBe('1');
  });

  it('clears the hero chat timers when it leaves', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const niche = NICHES[0];
    if (niche === undefined) {
      throw new Error('no niche');
    }
    await render(<ChatDemo niche={niche} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops watching the catalog drawing for resizes when it leaves', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect = disconnect;
      },
    );
    await render(<CatalogFlow />);
    await unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('the copy button', () => {
  it('says so when the browser will not copy', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const page = await render(<CopyButton text="hello" />);
    const button = page.querySelector('button');
    await act(async () => button?.click());
    expect(button?.textContent).toBe('Copy failed');
  });
});
