import { describe, expect, it } from 'vitest';
import {
  CLOSE_RESET_FALLBACK_MS,
  type ReopenDeps,
  type ShownWindow,
  createReopenReset,
  watchShown,
  wireReopen,
} from '../src/app/reopen';

/** A session stand-in: `terminal` is what is on screen; a reset draws the first step. */
function fakeSession(terminal = false) {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const state = { terminal, resets: 0 };
  const deps: ReopenDeps = {
    reset: () => {
      if (!state.terminal) {
        return false;
      }
      state.resets += 1;
      state.terminal = false;
      return true;
    },
    terminal: () => state.terminal,
    setTimer: (callback, ms) => {
      const id = next;
      next += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.callback();
    }
  };
  return { deps, state, timers, runTimers };
}

describe('the reset decision (D4)', () => {
  it('a finished order seen while shown resets once on the hide', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    session.state.terminal = true;
    machine.viewChanged();
    machine.shown(false);
    expect(session.state.resets).toBe(1);
  });

  it('a finished order that arrived while hidden is shown on the next open, then reset by the close after', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.shown(false);
    session.state.terminal = true;
    machine.viewChanged();
    machine.shown(true);
    expect(session.state.resets).toBe(0);
    machine.shown(false);
    expect(session.state.resets).toBe(1);
  });

  it('a hide right after the frame’s own close resets at once', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    session.state.terminal = true;
    // Never seen shown (no shown signal yet): only the frame's close counts.
    machine.closedFromFrame();
    machine.shown(true);
    machine.shown(false);
    expect(session.state.resets).toBe(1);
    expect(session.timers.size).toBe(0);
  });

  it('the frame’s own close with no hide resets after the fallback (M15)', () => {
    const session = fakeSession(true);
    const machine = createReopenReset(session.deps);
    machine.closedFromFrame();
    expect(session.state.resets).toBe(0);
    expect([...session.timers.values()].map((timer) => timer.ms)).toEqual([
      CLOSE_RESET_FALLBACK_MS,
    ]);
    session.runTimers();
    expect(session.state.resets).toBe(1);
  });

  it('the frame’s own close does nothing for an order not finished', () => {
    const session = fakeSession(false);
    const machine = createReopenReset(session.deps);
    machine.closedFromFrame();
    expect(session.timers.size).toBe(0);
  });

  it('never resets an order not finished, however often it hides', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    for (let turn = 0; turn < 3; turn += 1) {
      machine.shown(true);
      machine.viewChanged();
      machine.shown(false);
    }
    expect(session.state.resets).toBe(0);
  });

  it('a finished order that arrived while hidden is not reset by a repeated hide signal', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.shown(false);
    session.state.terminal = true;
    machine.viewChanged();
    machine.shown(false);
    expect(session.state.resets).toBe(0);
  });

  it('repeated hide signals reset once', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    session.state.terminal = true;
    machine.viewChanged();
    machine.shown(false);
    // The buyer bought again, and the order finished while the frame stayed hidden.
    session.state.terminal = true;
    machine.shown(false);
    machine.shown(false);
    expect(session.state.resets).toBe(1);
  });

  it('a view that leaves the finished order before the hide cancels the reset', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    session.state.terminal = true;
    machine.viewChanged();
    // Buy again pressed: the first step is drawn while shown.
    session.state.terminal = false;
    machine.viewChanged();
    machine.shown(false);
    expect(session.state.resets).toBe(0);
  });
});

/** A window stand-in whose observer and width the test drives. */
function fakeWindow(options: { observer?: boolean } = {}) {
  const resizes: (() => void)[] = [];
  const observers: ((entries: readonly { isIntersecting: boolean }[]) => void)[] = [];
  const observed: Element[] = [];
  const documentElement = { tagName: 'HTML' } as unknown as Element;
  class FakeObserver {
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) {
      observers.push(callback);
    }
    observe(target: Element) {
      observed.push(target);
    }
  }
  const self: ShownWindow = {
    innerWidth: 400,
    addEventListener: (_type, listener) => resizes.push(listener),
    ...(options.observer === false ? {} : { IntersectionObserver: FakeObserver }),
    document: { documentElement },
  };
  return {
    self,
    observed,
    documentElement,
    intersect: (isIntersecting: boolean) => {
      for (const callback of observers) {
        callback([{ isIntersecting }]);
      }
    },
    resize: (width: number) => {
      self.innerWidth = width;
      for (const listener of resizes) {
        listener();
      }
    },
  };
}

describe('the shown signal', () => {
  it('reads the observer on the document and the frame’s width, reporting changes only', () => {
    const page = fakeWindow();
    const seen: boolean[] = [];
    watchShown(page.self, (shown) => seen.push(shown));
    expect(page.observed).toEqual([page.documentElement]);
    // Not intersecting until the observer says so.
    expect(seen).toEqual([false]);
    page.intersect(true);
    page.intersect(true);
    expect(seen).toEqual([false, true]);
    page.resize(0);
    expect(seen).toEqual([false, true, false]);
    page.resize(400);
    page.intersect(false);
    expect(seen).toEqual([false, true, false, true, false]);
  });

  it('without an observer, the width alone', () => {
    const page = fakeWindow({ observer: false });
    const seen: boolean[] = [];
    watchShown(page.self, (shown) => seen.push(shown));
    expect(seen).toEqual([true]);
    page.resize(0);
    expect(seen).toEqual([true, false]);
  });

  it('is never fed by the page’s visibility: a tab switch is not a close', () => {
    const page = fakeWindow();
    const listened: string[] = [];
    const self: ShownWindow = {
      ...page.self,
      addEventListener: (type, listener) => {
        listened.push(type);
        page.self.addEventListener(type, listener);
      },
    };
    watchShown(self, () => undefined);
    expect(listened).toEqual(['resize']);
  });
});

describe('the wiring', () => {
  it('only in a modal: inline gets nothing (M14)', () => {
    const page = fakeWindow();
    const session = fakeSession(true);
    expect(wireReopen('inline', page.self, session.deps)).toBeUndefined();
    expect(wireReopen(undefined, page.self, session.deps)).toBeUndefined();
    expect(page.observed).toEqual([]);
    page.intersect(true);
    page.intersect(false);
    expect(session.state.resets).toBe(0);
  });

  it('in a modal, a close after the finished order was seen resets it', () => {
    const page = fakeWindow();
    const session = fakeSession();
    const machine = wireReopen('modal', page.self, session.deps);
    expect(machine).toBeDefined();
    page.intersect(true);
    session.state.terminal = true;
    machine?.viewChanged();
    page.intersect(false);
    expect(session.state.resets).toBe(1);
  });
});
