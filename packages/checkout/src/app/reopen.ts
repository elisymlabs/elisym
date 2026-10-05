/**
 * After a finished purchase, closing the modal returns the checkout to its
 * first step. The loaders tell the frame nothing on open or close, so the frame
 * watches whether it is shown: a closed dialog hides it (`display: none`).
 */

/** After the frame's own Done or Escape, a reset runs this long later if no hide signal came. */
export const CLOSE_RESET_FALLBACK_MS = 400;

export interface ReopenDeps {
  /** Go back to the first step; `false` when the session refused (nothing changed). */
  reset(): boolean;
  /** The view on screen is a finished order (completed or refunded). */
  terminal(): boolean;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ReopenReset {
  /** The frame became shown (`true`) or hidden (`false`). */
  shown(on: boolean): void;
  /** The session drew a new view. */
  viewChanged(): void;
  /** The frame itself asked the page to close the modal (Done, Escape inside). */
  closedFromFrame(): void;
}

/**
 * The reset decision. A finished order counts as seen once its view was on
 * screen while the frame was shown; a hide after that resets at once (the
 * frame redraws the first step while invisible). A finished view that arrived
 * while hidden is shown once on the next open, then reset by the close after.
 */
export function createReopenReset(deps: ReopenDeps): ReopenReset {
  let isShown = false;
  let seen = false;
  let pendingClose = false;
  let fallback: unknown;

  const stopFallback = () => {
    if (fallback !== undefined) {
      deps.clearTimer(fallback);
      fallback = undefined;
    }
  };
  const resetNow = () => {
    stopFallback();
    pendingClose = false;
    seen = false;
    if (deps.terminal()) {
      deps.reset();
    }
  };

  return {
    shown(on) {
      if (on === isShown) {
        return;
      }
      isShown = on;
      if (on) {
        if (deps.terminal()) {
          seen = true;
        }
        return;
      }
      if (seen || pendingClose) {
        resetNow();
      }
    },
    viewChanged() {
      seen = isShown && deps.terminal();
    },
    closedFromFrame() {
      if (!deps.terminal()) {
        return;
      }
      pendingClose = true;
      stopFallback();
      fallback = deps.setTimer(() => {
        fallback = undefined;
        if (pendingClose) {
          resetNow();
        }
      }, CLOSE_RESET_FALLBACK_MS);
    },
  };
}

/** The part of `window` the shown signal reads, so tests can stand in for it. */
export interface ShownWindow {
  innerWidth: number;
  addEventListener(type: 'resize', listener: () => void): void;
  IntersectionObserver?: new (
    callback: (entries: readonly { isIntersecting: boolean }[]) => void,
  ) => { observe(target: Element): void };
  document: { documentElement: Element };
}

/**
 * Whether the frame is shown: an intersection observer on the document (for a
 * cross-origin frame its root is the top viewport, and a hidden ancestor makes
 * it not intersecting), plus the frame's width falling to 0. Never the page's
 * visibility: switching tabs is not a close.
 */
export function watchShown(self: ShownWindow, onChange: (shown: boolean) => void): void {
  let intersecting = self.IntersectionObserver === undefined;
  let last: boolean | undefined;
  const report = () => {
    const shown = intersecting && self.innerWidth > 0;
    if (shown !== last) {
      last = shown;
      onChange(shown);
    }
  };
  if (self.IntersectionObserver !== undefined) {
    const observer = new self.IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) {
        intersecting = entry.isIntersecting;
        report();
      }
    });
    observer.observe(self.document.documentElement);
  }
  self.addEventListener('resize', report);
  report();
}

/**
 * In a modal only: the reset, fed by the frame's shown signal. Inline is never
 * closed, so it gets nothing (`undefined`).
 */
export function wireReopen(
  display: 'modal' | 'inline' | undefined,
  self: ShownWindow,
  deps: ReopenDeps,
): ReopenReset | undefined {
  if (display !== 'modal') {
    return undefined;
  }
  const machine = createReopenReset(deps);
  watchShown(self, (shown) => machine.shown(shown));
  return machine;
}
