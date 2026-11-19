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
import { DEMO_TIP } from '../src/components/DemoTips';
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
    const pause = page.querySelector<HTMLButtonElement>('button[aria-label$="the store demo"]');
    expect(pause?.textContent).toBe('Pause');
    expect(pause?.getAttribute('aria-label')).toBe('Pause the store demo');
    expect(pause?.hasAttribute('aria-pressed')).toBe(false);
    await act(async () => pause?.click());
    expect(pause?.getAttribute('aria-label')).toBe('Play the store demo');
    // Paused, the chat holds its finished conversation and nothing waits to move it on.
    expect(page.querySelector('#niche-demo .wgt-cards')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await playThrough();
    await playThrough();
    expect(selected()).toBe(1);
    await act(async () => pause?.click());
    await playThrough();
    expect(selected()).toBe(2);
    await act(async () => tabs(page)[0]?.click());
    expect(page.querySelector('button[aria-label$="the store demo"]')).toBeNull();
    await playThrough();
    await playThrough();
    expect(selected()).toBe(0);
  });

  it('plays to the end and stays on the store while the pointer is over it, then moves on', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const page = await render(<Hero />);
    const selected = () =>
      tabs(page).findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    const second = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    };
    const store = page.querySelector('#niche-demo')?.parentElement;
    await second();
    await act(async () => {
      store?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }),
      );
    });
    // Still playing: the question, then the answer with its cards.
    let answeredAt = -1;
    for (let tick = 0; tick < 30; tick += 1) {
      await second();
      if (answeredAt < 0 && page.querySelector('#niche-demo .wgt-cards') !== null) {
        answeredAt = tick;
      }
    }
    expect(answeredAt).toBeGreaterThanOrEqual(0);
    // Then it stays: the cards are still there, nothing replays, the store is the same.
    expect(page.querySelector('#niche-demo .wgt-cards')).not.toBeNull();
    expect(selected()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      store?.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    for (let tick = 0; tick < 8; tick += 1) {
      await second();
    }
    expect(selected()).toBe(1);
  });

  it('does not restart a step when the pointer crosses the store mid-conversation', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const page = await render(<Hero />);
    const store = page.querySelector('#niche-demo')?.parentElement;
    const cross = async (type: 'pointerover' | 'pointerout') => {
      await act(async () => {
        store?.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }));
      });
    };
    // The answer and its cards are due about 3.4 s in, whatever the pointer does on the way.
    for (let tick = 0; tick < 8; tick += 1) {
      await cross(tick % 2 === 0 ? 'pointerover' : 'pointerout');
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
    }
    expect(page.querySelector('#niche-demo .wgt-cards')).not.toBeNull();
  });

  it('carries on from the end when played again after a pause, never rewinding', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const page = await render(<Hero />);
    const second = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    };
    await second();
    const pause = page.querySelector<HTMLButtonElement>('button[aria-label$="the store demo"]');
    await act(async () => pause?.click());
    expect(page.querySelector('#niche-demo .wgt-cards')).not.toBeNull();
    await act(async () => pause?.click());
    for (let tick = 0; tick < 5; tick += 1) {
      await second();
      const selected = tabs(page).findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
      if (selected === 0) {
        expect(page.querySelector('#niche-demo .wgt-cards'), `second ${tick}`).not.toBeNull();
      }
    }
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

describe('the chat drawing', () => {
  it('scrolls only in the hero chat, so the page scrolls over the still drawings', async () => {
    const css = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.wgt-log')).toContain('overflow: hidden');
    expect(rule('.wgt-cards')).toContain('overflow: hidden');
    expect(rule('.wgt-live .wgt-log')).toContain('overflow-y: auto');
    // In the page's flow, the chat hands the scroll on to the page at its end: never a trap.
    expect(rule('.wgt-live .wgt-log')).not.toContain('overscroll-behavior');
    expect(rule('.wgt-live .wgt-cards')).toContain('overflow-x: auto');
    expect(rule('.wgt-live .wgt-cards')).toContain('scroll-snap-type: x mandatory');
    expect(rule('.wgt-live .wgt-cards > .wgt-card')).toContain('scroll-snap-align: start');
    stubMotion(true);
    const page = await render(<App />);
    expect(page.querySelector('#niche-demo .wgt-panel')?.classList.contains('wgt-live')).toBe(true);
    const still = [...page.querySelectorAll('#features .wgt-panel')];
    expect(still.length).toBeGreaterThan(0);
    for (const panel of still) {
      expect(panel.classList.contains('wgt-live')).toBe(false);
    }
  });
});

describe('the demo tips', () => {
  it('say it is a demo over every control of the chat drawing, and go when the pointer leaves', async () => {
    stubMotion(true);
    const page = await render(<Hero />);
    const controls = [...page.querySelectorAll('#niche-demo [data-demo]')];
    // Each kind of control, by name: close, the chips, the input, Send, Add to cart.
    for (const selector of ['.wgt-header', '.wgt-chip', '.wgt-input', '.wgt-send', '.wgt-cart']) {
      const marked = page.querySelector(`#niche-demo ${selector}`);
      const control = marked?.matches('[data-demo]')
        ? marked
        : marked?.querySelector('[data-demo]');
      expect(control, selector).not.toBeNull();
      expect(controls).toContain(control);
    }
    for (const control of controls) {
      await act(async () => {
        control.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
      expect(page.querySelector('.demo-tip')?.textContent).toBe(DEMO_TIP);
    }
    const area = controls[0]?.closest('figure')?.firstElementChild;
    await act(async () => {
      area?.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(page.querySelector('.demo-tip')).toBeNull();
    const reading = page.querySelector('#niche-demo .wgt-theirs');
    await act(async () => {
      reading?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(page.querySelector('.demo-tip')).toBeNull();
  });
});

describe('the demo tips on a touch screen', () => {
  it('stay a moment after a tap, as the finger leaves at once', async () => {
    stubMotion(true);
    vi.useFakeTimers();
    const page = await render(<Hero />);
    const send = page.querySelector('#niche-demo .wgt-send');
    const area = send?.closest('figure')?.firstElementChild;
    const touch = (type: string, init: MouseEventInit) => {
      const event = new MouseEvent(type, { bubbles: true, ...init });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      return event;
    };
    await act(async () => {
      send?.dispatchEvent(touch('pointerover', {}));
    });
    await act(async () => {
      area?.dispatchEvent(touch('pointerout', { relatedTarget: document.body }));
    });
    expect(page.querySelector('.demo-tip')?.textContent).toBe(DEMO_TIP);
    const wait = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    };
    // Two seconds, not less.
    await wait(1900);
    expect(page.querySelector('.demo-tip')).not.toBeNull();
    // A second tap within them starts its own two seconds.
    await act(async () => {
      send?.dispatchEvent(touch('pointerover', {}));
    });
    await act(async () => {
      area?.dispatchEvent(touch('pointerout', { relatedTarget: document.body }));
    });
    await wait(1900);
    expect(page.querySelector('.demo-tip')).not.toBeNull();
    await wait(200);
    expect(page.querySelector('.demo-tip')).toBeNull();
  });

  it('are placed through the CSSOM, never a style attribute the CSP would refuse', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/DemoTips.tsx'), 'utf8');
    expect(source).not.toContain("setAttribute('style'");
    expect(source).not.toMatch(/\bstyle=\{/);
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

  it('keeps the privacy facts and names in place', async () => {
    const page = await render(<App />);
    const rows = [...page.querySelectorAll('#trust figure li')].map((row) => row.textContent ?? '');
    const products = rows.find((row) => row.startsWith('Products and policies'));
    expect(products).toContain('on the open network');
    expect(products).not.toContain('signed by you');
    expect(rows.find((row) => row.startsWith('Settings'))).toContain('signed by you');
    const trust = page.querySelector('#trust')?.textContent ?? '';
    expect(trust).toContain('you replace it through your own site');
    expect(trust).toContain(
      'Your products and policies are published as signed listings on an open network.',
    );
    expect(trust).not.toMatch(/products and policies are signed with\b[^.]*\bkey/i);
    const footer = [...page.querySelectorAll('footer a')].find(
      (link) => link.getAttribute('href') === '#trust',
    );
    expect(footer?.textContent).toBe('Privacy');
    expect(page.querySelectorAll('#faq summary h1, #faq summary h2, #faq summary h3')).toHaveLength(
      0,
    );
    const injection = [...page.querySelectorAll('#faq details')].find((item) =>
      item.textContent?.includes('hidden instructions'),
    );
    expect(injection?.querySelector('p')?.textContent).not.toMatch(/^No\b/);
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
    const jump = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrolled = await render(<Closing />);
    const hidden = scrolled.querySelector<HTMLElement>('#closing .on-ink-focus');
    const section = scrolled.querySelector<HTMLElement>('#closing');
    if (hidden === null || section === null) {
      throw new Error('no closing');
    }
    Object.defineProperty(section, 'offsetTop', { value: 5000 });
    Object.defineProperty(section, 'offsetHeight', { value: 2900 });
    vi.stubGlobal('innerHeight', 900);
    expect(hidden.getAttribute('style') ?? '').not.toContain('visibility');
    await act(async () => {
      hidden.querySelector('a')?.focus();
    });
    // Reached by keyboard, the page jumps to where the dive has covered it in ink.
    expect(jump).toHaveBeenCalledWith({ top: 5000 + 2000 * 0.9, behavior: 'instant' });
    expect(hidden.style.opacity).toBe('1');
    expect(hidden.getAttribute('style') ?? '').not.toContain('visibility');
  });

  it('moves nothing on its own under reduced motion: no timers, no Pause buttons', async () => {
    stubMotion(true);
    vi.useFakeTimers();
    const page = await render(<App />);
    expect(page.querySelector('#niche-demo .wgt-cards')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(
      page.querySelectorAll('button[aria-label^="Pause"], button[aria-label^="Play"]'),
    ).toHaveLength(0);
  });

  it('reads each marquee item once, and gives the marquees no Pause button', async () => {
    stubMotion(false);
    const page = await render(<App />);
    for (const id of ['works-with', 'languages']) {
      const section = page.querySelector(`#${id}`);
      expect(section?.querySelectorAll('button'), id).toHaveLength(0);
      const tracks = [...(section?.querySelectorAll('.marquee-track') ?? [])];
      expect(tracks.length, id).toBeGreaterThan(0);
      for (const track of tracks) {
        const items = [...track.children];
        const read = items.filter((item) => item.getAttribute('aria-hidden') !== 'true');
        expect(read.length * 2, id).toBe(items.length);
      }
    }
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
