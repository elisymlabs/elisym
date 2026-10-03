/**
 * The frame's height, reported smoothly. The loaders are frozen and set the
 * frame to each reported height at once, so the checkout animates what it
 * reports: one height per animation frame toward the content's height. Any
 * report that lands on the target goes through `settle`.
 */

/** How long a height change takes on screen. */
export const HEIGHT_ANIMATION_MS = 200;
/** No animation frame this long (a throttled, hidden frame): the target is posted at once. */
export const FRAME_STALL_MS = 100;
/** The loaders' cap on the frame's height (`embed/v2/embed.ts`, `MAX_FRAME_HEIGHT`). */
export const MAX_FRAME_HEIGHT = 2000;

/** `FrameHandle` and `TimerHandle` are what the host's scheduler returns (numbers in a browser). */
export interface HeightDeps<FrameHandle, TimerHandle> {
  /** Tell the page the frame's height (the handshake drops it before the page's hello). */
  post(height: number): void;
  now(): number;
  requestFrame(callback: () => void): FrameHandle;
  cancelFrame(handle: FrameHandle): void;
  setTimer(callback: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** The buyer asked for less motion: every change is posted at once. */
  reducedMotion(): boolean;
  innerWidth(): number;
  innerHeight(): number;
  /** While growing toward a frame that follows the posts: no scrollbar flash. */
  setGrowing(on: boolean): void;
}

export interface HeightAnimator {
  /** The content's height changed. */
  target(height: number): void;
  /** The page said hello: what was posted before was dropped, so post the target now. */
  flush(height?: number): void;
}

/** An ease-out curve: fast first, settling softly. */
function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

export function createHeightAnimator<FrameHandle, TimerHandle>(
  deps: HeightDeps<FrameHandle, TimerHandle>,
): HeightAnimator {
  let goal: number | undefined;
  let posted: number | undefined;
  let postedWidth: number | undefined;
  let from = 0;
  let startedAt = 0;
  let frame: FrameHandle | undefined;
  let stall: TimerHandle | undefined;
  let growing = false;

  const post = (height: number) => {
    posted = height;
    postedWidth = deps.innerWidth();
    deps.post(height);
  };

  const mark = (on: boolean) => {
    growing = on;
    deps.setGrowing(on);
  };

  const stop = () => {
    if (frame !== undefined) {
      deps.cancelFrame(frame);
      frame = undefined;
    }
    if (stall !== undefined) {
      deps.clearTimer(stall);
      stall = undefined;
    }
  };

  /** Land on the target: the exact height, no growing class, nothing pending. */
  const settle = (height: number, force = false) => {
    stop();
    mark(false);
    if (force || posted !== height) {
      post(height);
    }
  };

  const armStall = () => {
    if (stall !== undefined) {
      deps.clearTimer(stall);
    }
    stall = deps.setTimer(() => {
      stall = undefined;
      if (goal !== undefined) {
        settle(goal);
      }
    }, FRAME_STALL_MS);
  };

  const step = () => {
    frame = undefined;
    if (goal === undefined) {
      return;
    }
    const progress = Math.min(1, (deps.now() - startedAt) / HEIGHT_ANIMATION_MS);
    if (progress >= 1) {
      settle(goal);
      return;
    }
    const height = Math.round(from + (goal - from) * easeOut(progress));
    if (height !== posted) {
      post(height);
    }
    frame = deps.requestFrame(step);
    armStall();
  };

  return {
    target(height: number) {
      const next = Math.ceil(height);
      goal = next;
      if (posted === undefined || deps.reducedMotion() || deps.innerWidth() !== postedWidth) {
        settle(next);
        return;
      }
      if (next === posted && frame === undefined) {
        return;
      }
      // Start (or restart) from what the page has now.
      from = posted;
      startedAt = deps.now();
      if (growing) {
        // A restart mid-growth: the frame lags a post behind, so its height says nothing of the cap.
        mark(next > posted && next <= MAX_FRAME_HEIGHT);
      } else {
        // Checked once, as a growth starts: a frame already held at the loader's cap never gets the class.
        mark(next > posted && deps.innerHeight() >= posted - 1 && next <= MAX_FRAME_HEIGHT);
      }
      if (frame === undefined) {
        frame = deps.requestFrame(step);
      }
      armStall();
    },
    flush(height?: number) {
      if (height !== undefined) {
        goal = Math.ceil(height);
      }
      if (goal !== undefined) {
        settle(goal, true);
      }
    },
  };
}
