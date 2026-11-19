// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/client';
import { WidgetView, defineAskrElement, scrollToNewest } from '../src/ui/element';
import { FakeGateway, FakeRelay, MemoryStorage, makeStore, publishStore } from './fixtures';

const HEIGHT = 480;
const REDUCE = '(prefers-reduced-motion: reduce)';

function log(): { box: HTMLElement; glides: ScrollToOptions[]; jumps: number[] } {
  const box = document.createElement('div');
  document.body.append(box);
  const glides: ScrollToOptions[] = [];
  const jumps: number[] = [];
  Object.defineProperty(box, 'scrollHeight', { get: () => HEIGHT });
  Object.defineProperty(box, 'scrollTop', {
    get: () => jumps.at(-1) ?? 0,
    set: (value: number) => jumps.push(value),
  });
  box.scrollTo = ((options: ScrollToOptions) => {
    glides.push(options);
  }) as typeof box.scrollTo;
  return { box, glides, jumps };
}

/** Reduced motion on or off, matching only the exact query the widget asks. */
function stubMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query === REDUCE,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  Reflect.deleteProperty(window, 'Askr');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('scrolling to the newest message', () => {
  it('glides to the bottom when the conversation grows', () => {
    stubMotion(false);
    const { box, glides, jumps } = log();
    scrollToNewest(box, true);
    expect(glides).toEqual([{ top: HEIGHT, behavior: 'smooth' }]);
    expect(jumps).toEqual([]);
  });

  it('jumps for the first turns, a chat opened on its history', () => {
    stubMotion(false);
    const { box, glides, jumps } = log();
    scrollToNewest(box, false);
    expect(glides).toEqual([]);
    expect(jumps).toEqual([HEIGHT]);
  });

  it('jumps for a visitor who asked for less motion', () => {
    stubMotion(true);
    const { box, glides, jumps } = log();
    scrollToNewest(box, true);
    expect(glides).toEqual([]);
    expect(jumps).toEqual([HEIGHT]);
  });

  it('jumps where the browser cannot glide', () => {
    stubMotion(false);
    const { box, jumps } = log();
    Reflect.set(box, 'scrollTo', undefined);
    scrollToNewest(box, true);
    expect(jumps).toEqual([HEIGHT]);
  });

  it("reads the widget's own window, not the page's", () => {
    stubMotion(true);
    const other = document.implementation.createHTMLDocument('elsewhere');
    const box = other.createElement('div');
    other.body.append(box);
    const glides: ScrollToOptions[] = [];
    box.scrollTo = ((options: ScrollToOptions) => {
      glides.push(options);
    }) as typeof box.scrollTo;
    Object.defineProperty(other, 'defaultView', {
      value: {
        matchMedia: () => ({ matches: false }) as MediaQueryList,
      },
    });
    scrollToNewest(box, true);
    expect(glides).toHaveLength(1);
  });

  it('jumps, and never throws, where the host page broke matchMedia', () => {
    for (const broken of [
      undefined,
      () => null,
      () => {
        throw new Error('no media');
      },
    ]) {
      vi.stubGlobal('matchMedia', broken);
      const { box, glides, jumps } = log();
      expect(() => scrollToNewest(box, true)).not.toThrow();
      expect(glides).toEqual([]);
      expect(jumps).toEqual([HEIGHT]);
    }
  });
});

describe('the panel log', () => {
  function panel(): { view: WidgetView; glide: ReturnType<typeof vi.fn>; jumps: number[] } {
    const view = new WidgetView(
      document,
      () => undefined,
      () => undefined,
    );
    document.body.append(view.panel);
    const panelLog = view.panel.querySelector<HTMLElement>('.log');
    if (panelLog === null) {
      throw new Error('no log');
    }
    // The greeting is already there; each message adds 100px, as a browser would lay it out.
    vi.spyOn(panelLog, 'scrollHeight', 'get').mockImplementation(
      () => 32 + panelLog.childElementCount * 100,
    );
    const jumps: number[] = [];
    vi.spyOn(panelLog, 'scrollTop', 'set').mockImplementation((value: number) => {
      jumps.push(value);
    });
    const glide = vi.fn();
    panelLog.scrollTo = glide as typeof panelLog.scrollTo;
    return { view, glide, jumps };
  }

  const turn = (askId: string) => ({ askId, text: `question ${askId}`, askedAt: 1 });

  it('jumps to the end of a restored history, then glides as new questions land', () => {
    stubMotion(false);
    const { view, glide, jumps } = panel();
    view.update({ phase: 'ready', branding: true, turns: [turn('a'), turn('b'), turn('c')] });
    expect(glide).not.toHaveBeenCalled();
    expect(jumps).toEqual([432]);
    view.update({
      phase: 'ready',
      branding: true,
      turns: [turn('a'), turn('b'), turn('c'), turn('d')],
    });
    expect(glide).toHaveBeenCalledWith({ top: 532, behavior: 'smooth' });
    glide.mockClear();
    view.update({
      phase: 'ready',
      branding: true,
      turns: [turn('a'), turn('b'), turn('c'), turn('d')],
    });
    expect(glide).not.toHaveBeenCalled();
  });

  it('shows the newest message at once when asked, as the panel opens', () => {
    stubMotion(false);
    const { view, glide, jumps } = panel();
    view.update({ phase: 'ready', branding: true, turns: [turn('a')] });
    jumps.length = 0;
    view.jumpToNewest();
    expect(jumps).toEqual([232]);
    expect(glide).not.toHaveBeenCalled();
  });
});

describe('<askr-chat>', () => {
  it('puts the newest message in view at once each time the panel opens', async () => {
    stubMotion(false);
    const jump = vi.spyOn(WidgetView.prototype, 'jumpToNewest');
    const store = makeStore();
    const relay = new FakeRelay();
    publishStore(relay, store);
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    let client: ChatClient | undefined;
    defineAskrElement(window, (owner) => {
      client = new ChatClient({
        owner,
        connect: relay.connect,
        gateway,
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage(),
      });
      return client;
    });
    const widget = document.createElement('askr-chat');
    widget.setAttribute('store', store.owner.pubkey);
    widget.setAttribute('theme', 'light');
    document.body.append(widget);
    const shadow = widget.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>('.launcher')?.click();
    expect(widget.hasAttribute('open')).toBe(true);
    expect(jump).toHaveBeenCalledTimes(1);
    shadow?.querySelector<HTMLButtonElement>('.close')?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    shadow?.querySelector<HTMLButtonElement>('.launcher')?.click();
    expect(jump).toHaveBeenCalledTimes(2);
    client?.stop();
  });

  it('keeps the reading place when the panel is reopened while it is still fading out', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const jump = vi.spyOn(WidgetView.prototype, 'jumpToNewest');
    const store = makeStore();
    const relay = new FakeRelay();
    publishStore(relay, store);
    const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
    let client: ChatClient | undefined;
    defineAskrElement(window, (owner) => {
      client = new ChatClient({
        owner,
        connect: relay.connect,
        gateway,
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage(),
      });
      return client;
    });
    const widget = document.createElement('askr-chat');
    widget.setAttribute('store', store.owner.pubkey);
    document.body.append(widget);
    const shadow = widget.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>('.launcher')?.click();
    expect(jump).toHaveBeenCalledTimes(1);
    shadow?.querySelector<HTMLButtonElement>('.close')?.click();
    expect(widget.hasAttribute('closing')).toBe(true);
    shadow?.querySelector<HTMLButtonElement>('.launcher')?.click();
    expect(widget.hasAttribute('open')).toBe(true);
    expect(jump).toHaveBeenCalledTimes(1);
    client?.stop();
    vi.useRealTimers();
  });
});
