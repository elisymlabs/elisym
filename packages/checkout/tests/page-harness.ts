/**
 * The frame as the embedding page sees it: what `main.tsx` wires around
 * `startPage`, with a content height per screen and view, the real height
 * animator (with motion, on a frame clock the test drives), and a resize
 * observer that reports after each draw. The log is everything the page hears.
 */
import type { OrderStore } from '@elisym/commerce/buyer';
import type { LoadDeps, Screen } from '../src/app/controller';
import { createHeightAnimator } from '../src/app/height';
import { holdFrame, startPage } from '../src/app/page';
import { type Banner, CheckoutSession, type SessionDeps, type View } from '../src/app/session';
import type { CheckoutParams } from '../src/embed/protocol';

/** A stand-in for each screen's laid-out height: every one differs. */
const SCREEN_HEIGHTS: Record<string, number> = {
  waiting: 60,
  loading: 100,
  refused: 180,
  offer: 360,
  working: 240,
  waiting_payment: 420,
  waiting_store: 400,
  old_prompt: 380,
  blocked: 300,
  cancelled: 260,
  delivered: 520,
  refunded: 480,
};

export interface FrameRun {
  /** What the page heard, in order: `status:<state>` and `resize:<height>`. */
  heard: string[];
  /** What the buyer sees in the frame now. */
  shown(): { screen: Screen; view: View | undefined; banner: Banner | undefined };
  /** Let the resize observer, pending promises and animation frames run. */
  settle(): Promise<void>;
  /** The frame's root classes (a held frame's scrolling never chains). */
  rootClasses: Set<string>;
  /** What the page had heard when the session's start began. */
  heardAtRun: string[] | undefined;
  dispose(): void;
}

export async function framePage(options: {
  params: CheckoutParams;
  pageOrigin: string;
  client: LoadDeps['client'];
  store: OrderStore;
  loadOffer: LoadDeps['loadOffer'];
  session: Omit<
    SessionDeps,
    'store' | 'onView' | 'onStatus' | 'onBanner' | 'followOnly' | 'customerRef' | 'collectEmail'
  >;
  /** Instead of a real session (a start that fails, say). */
  run?: Parameters<typeof startPage>[0]['run'];
  /** Where the page's hearing is written (a test may read it while the start runs). */
  heard?: string[];
}): Promise<FrameRun> {
  const heard: string[] = options.heard ?? [];
  let screen: Screen = { kind: 'waiting' };
  let view: View | undefined;
  let banner: Banner | undefined;
  let session: CheckoutSession | undefined;
  const contentHeight = () =>
    (view === undefined ? (SCREEN_HEIGHTS[screen.kind] ?? 0) : (SCREEN_HEIGHTS[view.kind] ?? 0)) +
    (banner === undefined ? 0 : 40);
  // A frame clock the test drives: frames and timers run only in `settle`.
  let clock = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const heights = createHeightAnimator<number, number>({
    post: (height) => heard.push(`resize:${height}`),
    now: () => clock,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    reducedMotion: () => false,
    innerWidth: () => 400,
    innerHeight: () => 800,
    setGrowing: () => undefined,
  });
  // The resize observer: a report after each draw, never inside it.
  const draw = () => {
    queueMicrotask(() => heights.target(contentHeight()));
  };
  const pumpFrames = () => {
    for (let turn = 0; turn < 40 && (frames.size > 0 || timers.size > 0); turn += 1) {
      clock += 16;
      const due = [...frames.entries()];
      frames.clear();
      for (const [, callback] of due) {
        callback();
      }
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= clock) {
          timers.delete(handle);
          timer.callback();
        }
      }
    }
  };
  const settle = async () => {
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      pumpFrames();
    }
  };
  const rootClasses = new Set<string>();
  let heardAtRun: string[] | undefined;
  heights.flush(contentHeight());
  await startPage({
    params: options.params,
    pageOrigin: options.pageOrigin,
    client: options.client,
    openStore: async () => options.store,
    loadOffer: options.loadOffer,
    frame: { parent: 'top', top: 'top' },
    show: (next) => {
      screen = next;
      draw();
    },
    status: (state) => heard.push(`status:${state}`),
    holdHeight: () => holdFrame({ classList: rootClasses }, heights, contentHeight()),
    run:
      options.run ??
      (async (offer, store, followOnly, onStatus) => {
        heardAtRun = [...heard];
        session = new CheckoutSession(offer, {
          ...options.session,
          store,
          onView: (next) => {
            view = next;
            draw();
          },
          onBanner: (next) => {
            banner = next;
            draw();
          },
          onStatus,
          ...(followOnly === undefined ? {} : { followOnly }),
        });
        await session.start();
      }),
    dropSession: () => {
      session?.dispose();
      session = undefined;
      view = undefined;
    },
  });
  await settle();
  return {
    heard,
    shown: () => ({ screen, view, banner }),
    settle,
    rootClasses,
    get heardAtRun() {
      return heardAtRun;
    },
    dispose: () => session?.dispose(),
  };
}
