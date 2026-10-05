import type { OrderStore } from '@elisym/commerce/buyer';
import type { CheckoutParams, CheckoutState } from '../embed/protocol';
import { type FollowOnly, type LoadDeps, type Screen, openPage, refRefusal } from './controller';
import type { HeightAnimator } from './height';

type ReadyOffer = Extract<Screen, { kind: 'offer' }>['offer'];
type Refused = Extract<Screen, { kind: 'refused' }>;

/** What the frame's start needs from the page it runs in, so tests can stand in for it. */
export interface PageDeps {
  /** `undefined`: the fragment names no product. */
  params: CheckoutParams | undefined;
  pageOrigin: string;
  client: LoadDeps['client'];
  /** The order store, or `undefined` when IndexedDB cannot be opened. */
  openStore(): Promise<OrderStore | undefined>;
  /** For a test only: the offer load (the page uses commerce's own). */
  loadOffer?: LoadDeps['loadOffer'];
  /** The frame's top window, for a reference (`window`). */
  frame: { parent: unknown; top: unknown };
  /** Draw a screen (no session view). */
  show(screen: Screen): void;
  /** Tell the page a state. */
  status(state: CheckoutState): void;
  /** Tell the page the drawn content's height now, and never another one. */
  holdHeight(): void;
  /**
   * Run the session for `offer` until its start settles; `onStatus` is what
   * the page hears of it. Throws when it failed.
   */
  run(
    offer: ReadyOffer,
    store: OrderStore,
    followOnly: FollowOnly | undefined,
    onStatus: (state: CheckoutState) => void,
  ): Promise<void>;
  /** The session failed: stop it and forget its view. */
  dropSession(): void;
}

/** The class a held frame's root gets. */
export const HELD_CLASS = 'held';

/**
 * Hold the frame as it is: its height told once, exactly and at once (no
 * animation keeps posting while a session works), then never again. The
 * same for every refusal, with or without an
 * order to follow, so nothing about the frame tells one from the other.
 */
export function holdFrame(
  root: { classList: { add(name: string): void } },
  heights: Pick<HeightAnimator, 'flush' | 'hold'>,
  contentHeight: number,
): void {
  heights.flush(contentHeight);
  heights.hold();
  // Accepted: a follow-only frame scrolls inside first, seen only by a visitor scrolling over it.
  root.classList.add(HELD_CLASS);
}

/**
 * Start the frame for the page that said hello. Every refusal looks the same
 * to the page: one `refused`, then the refusal's height, held. A refusal with
 * an earlier order of this browser to follow shows that order to the buyer
 * inside the held frame, and tells the page nothing more: a page embedding the
 * product never learns whether, or what, this browser bought.
 */
export async function startPage(deps: PageDeps): Promise<void> {
  let told = false;
  const refuse = (screen: Refused) => {
    deps.show(screen);
    // Told and held once: a later failure shows inside the held frame, unheard.
    if (!told) {
      told = true;
      deps.status('refused');
      deps.holdHeight();
    }
  };
  const params = deps.params;
  if (params === undefined) {
    refuse({ kind: 'refused', reason: 'no_product' });
    return;
  }
  // Before anything is read: a refused reference learns nothing of this browser's orders.
  const refRefused = refRefusal(params, deps.frame);
  if (refRefused !== undefined) {
    refuse({ kind: 'refused', reason: refRefused });
    return;
  }
  deps.show({ kind: 'loading' });
  try {
    const store = await deps.openStore();
    const opened = await openPage(params, deps.pageOrigin, {
      client: deps.client,
      store,
      ...(deps.loadOffer === undefined ? {} : { loadOffer: deps.loadOffer }),
    });
    if (opened.kind === 'refused' || store === undefined) {
      refuse(opened.kind === 'refused' ? opened.screen : { kind: 'refused', reason: 'no_storage' });
      return;
    }
    const followOnly = opened.followOnly;
    if (followOnly !== undefined) {
      // Exactly what a refusal with no order does, before the order is even read again.
      refuse(opened.refusal ?? { kind: 'refused', reason: 'offer_refused' });
      await deps.run(opened.offer, store, followOnly, () => undefined);
      return;
    }
    await deps.run(opened.offer, store, undefined, deps.status);
  } catch {
    // Storage or a relay failed in a way no check caught: never a Buy button then,
    // and nothing of the half-started session keeps running or drawing.
    deps.dropSession();
    refuse({ kind: 'refused', reason: 'failed' });
  }
}
