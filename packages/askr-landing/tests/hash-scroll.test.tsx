import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { useHashScroll } from '../src/useHashScroll';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SCROLL_OPTIONS = { behavior: 'instant', block: 'start' };

let root: Root | undefined;
let container: HTMLElement | undefined;
let outside: HTMLElement | undefined;

function Page() {
  useHashScroll();
  return (
    <main>
      <section id="pricing">Pricing</section>
      <section id="faq">FAQ</section>
      <section id="café">Café</section>
    </main>
  );
}

/** Stands in for the hook alone, with the sections kept outside the root it unmounts with. */
function HookOnly() {
  useHashScroll();
  return null;
}

interface Options {
  readyState: DocumentReadyState;
  navigation?: string;
  page?: React.ReactElement;
}

/** Opens the page at `hash`, in a document that is still loading or already loaded. */
async function open(hash: string, { readyState, navigation = 'navigate', page }: Options) {
  window.history.replaceState(null, '', `/${hash}`);
  vi.spyOn(document, 'readyState', 'get').mockReturnValue(readyState);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) =>
    type === 'navigation' ? [{ type: navigation } as unknown as PerformanceEntry] : [],
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    frames.delete(handle);
  });
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    expect(options).toEqual(SCROLL_OPTIONS);
    scrolled.push(this.id);
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(page ?? <Page />));
  const runFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) {
      frame(0);
    }
  };
  return { scrolled, runFrames };
}

async function close() {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
}

afterEach(async () => {
  await close();
  outside?.remove();
  outside = undefined;
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('opening the page at a section', () => {
  it('scrolls to the section once the page has rendered', async () => {
    const { scrolled, runFrames } = await open('#pricing', { readyState: 'complete' });
    expect(scrolled).toEqual([]);
    runFrames();
    expect(scrolled).toEqual(['pricing']);
    window.dispatchEvent(new Event('load'));
    expect(scrolled).toEqual(['pricing']);
  });

  it('scrolls again when the page finishes loading', async () => {
    const { scrolled, runFrames } = await open('#faq', { readyState: 'interactive' });
    runFrames();
    window.dispatchEvent(new Event('load'));
    expect(scrolled).toEqual(['faq', 'faq']);
  });

  it.each(['wheel', 'touchstart', 'keydown', 'pointerdown'])(
    'leaves the page where the visitor took it with %s before it finished loading',
    async (name) => {
      const { scrolled, runFrames } = await open('#pricing', { readyState: 'loading' });
      runFrames();
      window.dispatchEvent(new Event(name));
      window.dispatchEvent(new Event('load'));
      expect(scrolled).toEqual(['pricing']);
    },
  );

  it.each(['reload', 'back_forward'])(
    'keeps the position the browser restores on a %s',
    async (navigation) => {
      const { scrolled, runFrames } = await open('#pricing', {
        readyState: 'interactive',
        navigation,
      });
      runFrames();
      window.dispatchEvent(new Event('load'));
      expect(scrolled).toEqual([]);
    },
  );

  it('does nothing for an address with no hash, or one naming no section', async () => {
    const plain = await open('', { readyState: 'loading' });
    plain.runFrames();
    window.dispatchEvent(new Event('load'));
    expect(plain.scrolled).toEqual([]);
    await close();
    vi.restoreAllMocks();
    const unknown = await open('#nowhere', { readyState: 'loading' });
    unknown.runFrames();
    window.dispatchEvent(new Event('load'));
    expect(unknown.scrolled).toEqual([]);
  });

  it('finds a section whose id the address encodes, and ignores a hash that cannot be decoded', async () => {
    const encoded = await open('#caf%C3%A9', { readyState: 'complete' });
    encoded.runFrames();
    expect(encoded.scrolled).toEqual(['café']);
    await close();
    vi.restoreAllMocks();
    const broken = await open('#%E0%A4%A', { readyState: 'complete' });
    broken.runFrames();
    expect(broken.scrolled).toEqual([]);
  });

  it('stops waiting for the frame and the load when the page goes away first', async () => {
    outside = document.createElement('section');
    outside.id = 'pricing';
    document.body.append(outside);
    const { scrolled, runFrames } = await open('#pricing', {
      readyState: 'loading',
      page: <HookOnly />,
    });
    await close();
    runFrames();
    window.dispatchEvent(new Event('load'));
    expect(scrolled).toEqual([]);
  });

  it('is what the landing does', async () => {
    const { scrolled, runFrames } = await open('#pricing', {
      readyState: 'complete',
      page: <App />,
    });
    runFrames();
    expect(scrolled).toEqual(['pricing']);
  });
});
