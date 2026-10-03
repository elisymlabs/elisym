import { describe, expect, it } from 'vitest';
import { type FocusWindow, armFirstFocus, closeOnEscape } from '../src/app/modal-frame';

type FocusEvent = 'focus' | 'pointerdown' | 'keydown';

/** A frame window whose focus and listeners the test drives. */
function fakeWindow(hasFocus: boolean) {
  const listeners = new Map<FocusEvent, Set<() => void>>();
  const self: FocusWindow & { focused: boolean; fire(type: FocusEvent): void } = {
    focused: hasFocus,
    document: { hasFocus: () => self.focused },
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type) => {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener();
      }
    },
  };
  return self;
}

describe('the first focus in a modal', () => {
  it('focuses the heading at once when the frame already has focus at the first view', () => {
    const self = fakeWindow(true);
    let moves = 0;
    const firstFocus = armFirstFocus(self, () => (moves += 1));
    firstFocus.ready();
    self.fire('focus');
    firstFocus.ready();
    expect(moves).toBe(1);
  });

  it('otherwise waits for the first focus (the loader focusing the frame on open)', () => {
    const self = fakeWindow(false);
    let moves = 0;
    const firstFocus = armFirstFocus(self, () => (moves += 1));
    firstFocus.ready();
    expect(moves).toBe(0);
    self.focused = true;
    self.fire('focus');
    self.fire('focus');
    expect(moves).toBe(1);
  });

  it('a focus before the first view moves it once the view is drawn, if still focused', () => {
    const self = fakeWindow(false);
    let moves = 0;
    const firstFocus = armFirstFocus(self, () => (moves += 1));
    self.focused = true;
    self.fire('focus');
    expect(moves).toBe(0);
    firstFocus.ready();
    expect(moves).toBe(1);
  });

  it('never pulls focus back once the buyer is elsewhere', () => {
    const self = fakeWindow(false);
    let moves = 0;
    const firstFocus = armFirstFocus(self, () => (moves += 1));
    self.fire('focus');
    // The focus went away again before the first view.
    firstFocus.ready();
    self.focused = true;
    self.fire('focus');
    expect(moves).toBe(0);
  });

  it("the buyer's own first click or key disarms it", () => {
    for (const type of ['pointerdown', 'keydown'] as const) {
      const self = fakeWindow(false);
      let moves = 0;
      const firstFocus = armFirstFocus(self, () => (moves += 1));
      firstFocus.ready();
      self.fire(type);
      self.focused = true;
      self.fire('focus');
      expect(moves).toBe(0);
    }
  });
});

describe('Escape in a modal frame', () => {
  it('asks the page to close, and nothing else does', () => {
    let listener: ((event: { key: string; defaultPrevented: boolean }) => void) | undefined;
    let closes = 0;
    closeOnEscape(
      {
        addEventListener: (_type, added) => {
          listener = added;
        },
      },
      () => (closes += 1),
    );
    listener?.({ key: 'Enter', defaultPrevented: false });
    listener?.({ key: 'Escape', defaultPrevented: false });
    expect(closes).toBe(1);
  });

  it('leaves an Escape something in the frame handled (an open list) to it', () => {
    let listener: ((event: { key: string; defaultPrevented: boolean }) => void) | undefined;
    let closes = 0;
    closeOnEscape(
      {
        addEventListener: (_type, added) => {
          listener = added;
        },
      },
      () => (closes += 1),
    );
    listener?.({ key: 'Escape', defaultPrevented: true });
    expect(closes).toBe(0);
  });
});
