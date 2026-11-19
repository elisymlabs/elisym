// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetView, scrollToNewest } from '../src/ui/element';

const HEIGHT = 480;

function log(): { box: HTMLElement; glides: ScrollToOptions[]; jumps: number[] } {
  const box = document.createElement('div');
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

afterEach(() => {
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

  it('jumps on the first fill, a chat opened on its history', () => {
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

  it('glides the panel log as a new question lands under earlier ones', () => {
    stubMotion(false);
    const view = new WidgetView(
      document,
      () => undefined,
      () => undefined,
    );
    const panelLog = view.panel.querySelector<HTMLElement>('.log');
    if (panelLog === null) {
      throw new Error('no log');
    }
    // Each message adds 100px, as a browser would lay it out (happy-dom measures 0).
    vi.spyOn(panelLog, 'scrollHeight', 'get').mockImplementation(
      () => panelLog.childElementCount * 100,
    );
    const glide = vi.fn();
    panelLog.scrollTo = glide as typeof panelLog.scrollTo;
    const turn = (askId: string) => ({ askId, text: `question ${askId}`, askedAt: 1 });
    view.update({ phase: 'ready', branding: true, turns: [turn('a')] });
    expect(glide).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' });
    glide.mockClear();
    view.update({ phase: 'ready', branding: true, turns: [turn('a'), turn('b')] });
    expect(glide).toHaveBeenCalledWith({ top: 300, behavior: 'smooth' });
    glide.mockClear();
    view.update({ phase: 'ready', branding: true, turns: [turn('a'), turn('b')] });
    expect(glide).not.toHaveBeenCalled();
  });
});
