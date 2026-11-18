// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAskrElement } from '../src/ui/element';

const CLOSE_MS = 180;
let still = false;

defineAskrElement(window, () => {
  throw new Error('no client in these tests: the element has no store');
});

/** A widget without a store: it opens and closes, and never starts a client. */
function mount(): { widget: HTMLElement; launcher: HTMLButtonElement; close: HTMLButtonElement } {
  const widget = document.createElement('askr-chat');
  document.body.append(widget);
  const launcher = widget.shadowRoot?.querySelector<HTMLButtonElement>('.launcher');
  const close = widget.shadowRoot?.querySelector<HTMLButtonElement>('.close');
  if (!launcher || !close) {
    throw new Error('the widget did not render');
  }
  return { widget, launcher, close };
}

beforeEach(() => {
  still = false;
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') && still }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the panel opening and closing', () => {
  it('opens at once and closes after a short fade, the launcher coming back after it', () => {
    const { widget, launcher, close } = mount();
    launcher.click();
    expect(widget.hasAttribute('open')).toBe(true);
    close.click();
    expect(widget.hasAttribute('closing')).toBe(true);
    expect(widget.hasAttribute('open')).toBe(true);
    vi.advanceTimersByTime(CLOSE_MS - 1);
    expect(widget.hasAttribute('open')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(widget.hasAttribute('open')).toBe(false);
    expect(widget.hasAttribute('closing')).toBe(false);
  });

  it('closes at once for a visitor who asked for reduced motion', () => {
    still = true;
    const { widget, launcher, close } = mount();
    launcher.click();
    close.click();
    expect(widget.hasAttribute('open')).toBe(false);
    expect(widget.hasAttribute('closing')).toBe(false);
  });

  it('opened again while it fades stays open', () => {
    const { widget, launcher, close } = mount();
    launcher.click();
    close.click();
    launcher.click();
    expect(widget.hasAttribute('closing')).toBe(false);
    vi.advanceTimersByTime(CLOSE_MS * 2);
    expect(widget.hasAttribute('open')).toBe(true);
  });
});

describe('closing details', () => {
  it('a widget already closed is not set closing', () => {
    const { widget, close } = mount();
    close.click();
    expect(widget.hasAttribute('closing')).toBe(false);
  });

  it('closes at once where the browser has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { widget, launcher, close } = mount();
    launcher.click();
    close.click();
    expect(widget.hasAttribute('open')).toBe(false);
  });

  it('takes no input while it fades, and gives focus back to the launcher', () => {
    const { widget, launcher, close } = mount();
    launcher.click();
    close.focus();
    close.click();
    const panel = widget.shadowRoot?.querySelector('.panel');
    expect(panel?.hasAttribute('inert')).toBe(true);
    vi.advanceTimersByTime(CLOSE_MS);
    expect(panel?.hasAttribute('inert')).toBe(false);
    expect(widget.shadowRoot?.activeElement).toBe(launcher);
  });

  it('a widget taken off the page while it fades forgets the fade', () => {
    const { widget, launcher, close } = mount();
    launcher.click();
    close.click();
    widget.remove();
    expect(widget.hasAttribute('closing')).toBe(false);
  });
});
