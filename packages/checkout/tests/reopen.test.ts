import { describe, expect, it } from 'vitest';
import {
  CLOSE_RESET_FALLBACK_MS,
  type ReopenDeps,
  type ShownWindow,
  createReopenReset,
  watchShown,
  wireReopen,
} from '../src/app/reopen';

/** A session stand-in: every reset it accepts draws the first step; `refuse` makes it say no. */
function fakeSession() {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const state = { resets: 0, refuse: false, asked: 0 };
  const deps: ReopenDeps = {
    reset: () => {
      state.asked += 1;
      if (state.refuse) {
        return false;
      }
      state.resets += 1;
      return true;
    },
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

describe('the reset decision (D6)', () => {
  it('a hide after a show resets once, whatever is on screen', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.shown(false);
    expect(session.state.resets).toBe(1);
    // Repeated hide signals reset nothing more.
    machine.shown(false);
    expect(session.state.resets).toBe(1);
    // Every close resets: shown again, hidden again.
    machine.shown(true);
    machine.shown(false);
    expect(session.state.resets).toBe(2);
  });

  it('a hide with no show before it does nothing', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(false);
    expect(session.state.asked).toBe(0);
  });

  it('the frame’s own close with no hide resets after the fallback, once (M15)', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.closedFromFrame();
    expect(session.state.resets).toBe(0);
    expect([...session.timers.values()].map((timer) => timer.ms)).toEqual([
      CLOSE_RESET_FALLBACK_MS,
    ]);
    session.runTimers();
    expect(session.state.resets).toBe(1);
    session.runTimers();
    expect(session.state.resets).toBe(1);
  });

  it('the frame’s own close twice within the fallback keeps one fallback: one reset, no timer left', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.closedFromFrame();
    machine.closedFromFrame();
    expect(session.timers.size).toBe(1);
    session.runTimers();
    expect(session.state.resets).toBe(1);
    expect(session.timers.size).toBe(0);
  });

  it('a hide right after the frame’s own close resets at once, and the fallback never runs', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    machine.shown(true);
    machine.closedFromFrame();
    machine.shown(false);
    expect(session.state.resets).toBe(1);
    expect(session.timers.size).toBe(0);
    session.runTimers();
    expect(session.state.resets).toBe(1);
  });

  it('a refused reset changes nothing, and the next close asks again', () => {
    const session = fakeSession();
    const machine = createReopenReset(session.deps);
    session.state.refuse = true;
    machine.shown(true);
    machine.shown(false);
    expect(session.state.asked).toBe(1);
    expect(session.state.resets).toBe(0);
    session.state.refuse = false;
    machine.shown(true);
    machine.shown(false);
    expect(session.state.resets).toBe(1);
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
    const session = fakeSession();
    expect(wireReopen('inline', page.self, session.deps)).toBeUndefined();
    expect(wireReopen(undefined, page.self, session.deps)).toBeUndefined();
    expect(page.observed).toEqual([]);
    page.intersect(true);
    page.intersect(false);
    expect(session.state.asked).toBe(0);
  });

  it('in a modal, any close resets (M20)', () => {
    const page = fakeWindow();
    const session = fakeSession();
    const machine = wireReopen('modal', page.self, session.deps);
    expect(machine).toBeDefined();
    page.intersect(true);
    page.intersect(false);
    expect(session.state.resets).toBe(1);
  });
});
