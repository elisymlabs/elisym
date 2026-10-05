import { describe, expect, it } from 'vitest';
import {
  FRAME_STALL_MS,
  HEIGHT_ANIMATION_MS,
  MAX_FRAME_HEIGHT,
  createHeightAnimator,
} from '../src/app/height';

/**
 * A page whose frames and timers the test runs, and a loader that sets each post as the
 * frame's height (with `late`, one animation frame after the post).
 */
function page(options: { reduced?: boolean; capAt?: number; late?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  let unapplied: number | undefined;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; at: number }>();
  const state = {
    posts: [] as number[],
    width: 400,
    frameHeight: 150,
    growing: false,
    reduced: options.reduced ?? false,
  };
  const animator = createHeightAnimator({
    post: (height) => {
      state.posts.push(height);
      const applied = Math.min(height, options.capAt ?? MAX_FRAME_HEIGHT);
      if (options.late === true) {
        unapplied = applied;
      } else {
        state.frameHeight = applied;
      }
    },
    now: () => now,
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (handle) => frames.delete(handle),
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { callback, at: now + ms });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle),
    reducedMotion: () => state.reduced,
    innerWidth: () => state.width,
    innerHeight: () => state.frameHeight,
    setGrowing: (on) => {
      state.growing = on;
    },
  });
  /** One animation frame, `ms` after the last. */
  const frame = (ms = 16) => {
    now += ms;
    if (unapplied !== undefined) {
      state.frameHeight = unapplied;
      unapplied = undefined;
    }
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) {
      callback();
    }
    fireTimers();
  };
  /** Time passes with no animation frame (a throttled, hidden frame). */
  const wait = (ms: number) => {
    now += ms;
    fireTimers();
  };
  const fireTimers = () => {
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { animator, state, frame, wait, pendingFrames: () => frames.size };
}

describe('the frame height', () => {
  it('posts the first height at once', () => {
    const view = page();
    view.animator.target(300.2);
    expect(view.state.posts).toEqual([301]);
  });

  it('animates a later change, ending exactly on the target', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(500);
    expect(view.state.posts).toEqual([300]);
    for (let elapsed = 0; elapsed < HEIGHT_ANIMATION_MS + 32; elapsed += 16) {
      view.frame();
    }
    const steps = view.state.posts.slice(1);
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.at(-1)).toBe(500);
    expect(steps.every((height) => height > 300 && height <= 500)).toBe(true);
    expect(view.pendingFrames()).toBe(0);
  });

  it('continues from where it is when the target changes on the way', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(500);
    view.frame();
    view.frame();
    const midway = view.state.posts.at(-1) ?? 0;
    view.animator.target(350);
    view.frame();
    expect(view.state.posts.at(-1)).toBeLessThanOrEqual(midway);
    for (let index = 0; index < 20; index += 1) {
      view.frame();
    }
    expect(view.state.posts.at(-1)).toBe(350);
  });

  it('posts at once when the buyer asked for less motion', () => {
    const view = page({ reduced: true });
    view.animator.target(300);
    view.animator.target(500);
    expect(view.state.posts).toEqual([300, 500]);
  });

  it('posts nothing for the height already posted', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(300);
    view.frame();
    expect(view.state.posts).toEqual([300]);
  });

  it('posts at once when the width changed (the modal opened, the phone turned)', () => {
    const view = page();
    view.animator.target(300);
    view.state.width = 600;
    view.animator.target(420);
    expect(view.state.posts).toEqual([300, 420]);
  });

  it('still animates a new target while the frame follows the posts (never on height alone)', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(500);
    view.frame();
    view.frame();
    const count = view.state.posts.length;
    // A cross-origin frame applies each post a frame late: its height lags what was posted.
    view.state.frameHeight = (view.state.posts.at(-1) ?? 0) - 20;
    view.animator.target(600);
    expect(view.state.posts.length).toBe(count);
    view.frame();
    expect(view.state.posts.at(-1)).toBeLessThan(600);
  });

  it('ends on the target when animation frames stop coming', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(500);
    view.wait(FRAME_STALL_MS);
    expect(view.state.posts.at(-1)).toBe(500);
    expect(view.state.growing).toBe(false);
  });

  it('marks the page as growing only while it grows, and clears it on the last step', () => {
    const view = page();
    view.animator.target(300);
    view.animator.target(500);
    expect(view.state.growing).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      view.frame();
    }
    expect(view.state.growing).toBe(false);
  });

  it('never marks a frame already held at its cap', () => {
    const view = page({ capAt: 280 });
    view.animator.target(300);
    view.animator.target(500);
    expect(view.state.growing).toBe(false);
  });

  it('clears the growing mark when the cap is reached on the way', () => {
    const view = page({ capAt: 420 });
    view.animator.target(300);
    view.animator.target(500);
    expect(view.state.growing).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      view.frame();
    }
    expect(view.state.posts.at(-1)).toBe(500);
    expect(view.state.growing).toBe(false);
  });

  it('keeps the growing mark on a restart mid-growth, with a loader a frame behind', () => {
    const view = page({ late: true });
    view.animator.target(300);
    view.frame();
    view.animator.target(500);
    view.frame();
    view.frame();
    expect(view.state.frameHeight).toBeLessThan(view.state.posts.at(-1) ?? 0);
    view.animator.target(600);
    expect(view.state.growing).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      view.frame();
    }
    expect(view.state.posts.at(-1)).toBe(600);
    expect(view.state.growing).toBe(false);
  });

  it('never marks a capped frame, restarted mid-growth, with a loader a frame behind', () => {
    const view = page({ late: true, capAt: 280 });
    view.animator.target(300);
    view.frame();
    view.animator.target(500);
    expect(view.state.growing).toBe(false);
    view.frame();
    view.frame();
    view.animator.target(600);
    expect(view.state.growing).toBe(false);
  });

  for (const [name, interrupt] of [
    [
      'a width change',
      (view: ReturnType<typeof page>) => {
        view.state.width = 700;
        view.animator.target(500);
      },
    ],
    [
      'less motion turned on',
      (view: ReturnType<typeof page>) => {
        view.state.reduced = true;
        view.animator.target(500);
      },
    ],
  ] as const) {
    it(`lands exactly on the target, unmarked, on ${name} mid-growth`, () => {
      const view = page();
      view.animator.target(300);
      view.animator.target(500);
      view.frame();
      interrupt(view);
      expect(view.state.posts.at(-1)).toBe(500);
      expect(view.state.growing).toBe(false);
      expect(view.pendingFrames()).toBe(0);
    });
  }

  it('posts the target again on the page hello: what came before was dropped', () => {
    const view = page();
    view.animator.target(300);
    view.animator.flush();
    expect(view.state.posts).toEqual([300, 300]);
  });

  it('on the hello posts a height measured then, at once', () => {
    const view = page();
    view.animator.flush(260);
    expect(view.state.posts).toEqual([260]);
    view.animator.target(400);
    expect(view.state.posts).toEqual([260]);
  });
});

describe('a held frame', () => {
  it('posts nothing more: opening the purchases, a detail or a download in it changes nothing (H4)', () => {
    const view = page();
    view.animator.flush(240);
    view.animator.hold();
    const posted = [...view.state.posts];
    for (const height of [600, 240, 900]) {
      view.animator.target(height);
      for (let elapsed = 0; elapsed < HEIGHT_ANIMATION_MS + 32; elapsed += 16) {
        view.frame();
      }
    }
    expect(view.state.posts).toEqual(posted);
  });
});
