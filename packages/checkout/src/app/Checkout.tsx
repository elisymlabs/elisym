import type { Network } from '@elisym/pay-core';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Screen } from './controller';
import type { Banner, View } from './session';
import { BannerNote } from './ui/BannerNote';
import { isPhone } from './ui/device';
import { DoneStep } from './ui/DoneStep';
import { EndedStep } from './ui/EndedStep';
import { Footer } from './ui/Footer';
import { RETURN_GLYPH, STOP_GLYPH } from './ui/glyphs';
import { Header, type StoreInfo } from './ui/Header';
import { OldPromptStep } from './ui/OldPromptStep';
import { ProgressStep } from './ui/ProgressStep';
import { ReviewStep } from './ui/ReviewStep';
import { INITIAL_TRACKER, type Step, advanceStep, shownProblem } from './ui/steps';
import { REFUSALS } from './ui/text';
import { WalletsStep } from './ui/WalletsStep';

export interface Actions {
  confirm(checked: boolean): void;
  choosePayout(index: number): void;
  confirmOldPrompt(): Promise<void>;
  cancelOldPrompt(): void;
  setEmail(value: string): void;
  pay(walletName: string): Promise<void>;
  retry(walletName: string): Promise<void>;
  startOver(): Promise<void>;
}

interface Props {
  /** Before the purchase session starts: waiting, loading or refused. */
  screen: Screen;
  /** The purchase, once the offer is loaded. */
  view?: View;
  /** A late answer for another order of this product, shown above whatever is on screen. */
  banner?: Banner;
  actions: Actions;
}

/** The network a view is about, when it says. */
function networkOf(view: View | undefined): Network | undefined {
  if (view === undefined) {
    return undefined;
  }
  if (view.kind === 'offer') {
    return view.payout.target.caip19.chain.network;
  }
  if (view.kind === 'working' || view.kind === 'waiting_payment' || view.kind === 'waiting_store') {
    return view.paying?.network;
  }
  return undefined;
}

/**
 * The checkout card: a header (the store, its trust level), one step, and a
 * footer. Store data is rendered as text only; a delivery is a link only when
 * it is `https:`. Steps are UI state over the session's views: the session
 * decides what is possible, this only decides which part of the offer shows.
 */
export function Checkout({ screen, view, banner, actions }: Props) {
  const tracker = useRef(INITIAL_TRACKER);
  const seen = useRef<View | undefined>(undefined);
  const email = useRef('');
  const store = useRef<StoreInfo | undefined>(undefined);
  const network = useRef<Network | undefined>(undefined);
  /** A buyer's action is running: the first view it produces takes focus. */
  const armed = useRef(false);
  const focusHeading = useRef(false);
  const card = useRef<HTMLElement>(null);
  const [, redraw] = useState(0);

  if (view !== seen.current) {
    seen.current = view;
    tracker.current = advanceStep(tracker.current, view);
    network.current = networkOf(view) ?? network.current;
    if (view?.kind === 'offer') {
      // Reseeded from the session on every offer: what is shown is what is sent.
      email.current = view.email;
      const { profile, level, domain } = view.offer.offer;
      store.current = { name: profile.name, level, domain };
    }
    if (armed.current && view !== undefined) {
      armed.current = false;
      focusHeading.current = true;
    }
  }

  useEffect(() => {
    if (!focusHeading.current) {
      return;
    }
    focusHeading.current = false;
    // Never pulls focus back once the buyer is elsewhere.
    if (document.hasFocus()) {
      card.current?.querySelector<HTMLElement>('[data-heading]')?.focus({ preventScroll: true });
    }
  });

  const run = (action: () => Promise<void>) => {
    armed.current = true;
    void action().finally(() => {
      armed.current = false;
    });
  };
  const goTo = (step: Step) => {
    const leaving = view?.kind === 'offer' ? view.problem : undefined;
    tracker.current = { ...tracker.current, step, dismissed: leaving ?? tracker.current.dismissed };
    focusHeading.current = true;
    redraw((count) => count + 1);
  };
  const setEmail = (value: string) => {
    email.current = value;
    actions.setEmail(value);
    redraw((count) => count + 1);
  };
  const startOver = () => run(() => actions.startOver());

  let body: ComponentChildren;
  if (view === undefined) {
    body =
      screen.kind === 'refused' ? (
        <EndedStep glyph={STOP_GLYPH} title="Not available" alert>
          <p>{REFUSALS[screen.reason]}</p>
          {screen.message === undefined ? null : <p class="note">{screen.message}</p>}
        </EndedStep>
      ) : (
        <p class="status loading" role="status">
          Loading…
        </p>
      );
  } else {
    const problem =
      view.kind === 'offer' || view.kind === 'waiting_payment'
        ? shownProblem(tracker.current, view.problem)
        : undefined;
    switch (view.kind) {
      case 'offer':
        body =
          tracker.current.step === 'review' ? (
            <ReviewStep
              view={view}
              problem={problem}
              email={email.current}
              onEmail={setEmail}
              onConfirm={actions.confirm}
              onChoose={actions.choosePayout}
              onContinue={() => goTo('wallets')}
            />
          ) : (
            <WalletsStep
              view={view}
              problem={problem}
              phone={isPhone(navigator.userAgent)}
              onBack={() => goTo('review')}
              onPay={(name) => run(() => actions.pay(name))}
            />
          );
        break;
      case 'working':
      case 'waiting_payment':
      case 'waiting_store':
        body = (
          <ProgressStep
            view={view}
            problem={problem}
            onConfirm={actions.confirm}
            onRetry={(name) => run(() => actions.retry(name))}
            onStartOver={startOver}
          />
        );
        break;
      case 'old_prompt':
        body = (
          <OldPromptStep
            view={view}
            onContinue={() => run(() => actions.confirmOldPrompt())}
            onBack={actions.cancelOldPrompt}
          />
        );
        break;
      case 'delivered':
        body = <DoneStep view={view} onBuyAgain={startOver} />;
        break;
      case 'refunded':
        body = (
          <EndedStep
            glyph={RETURN_GLYPH}
            title="Refunded"
            action={{ label: 'Start a new order', run: startOver }}
          >
            <p>The store cancelled this order and refunded the payment.</p>
          </EndedStep>
        );
        break;
      case 'cancelled':
        body = (
          <EndedStep
            glyph={STOP_GLYPH}
            title="Cancelled"
            action={{ label: 'Start a new order', run: startOver }}
          >
            <p>The store cancelled this order. Nothing was paid.</p>
          </EndedStep>
        );
        break;
      case 'blocked':
        body = (
          <EndedStep glyph={STOP_GLYPH} title="Payment blocked" alert>
            <p>
              The payment was blocked by the recipient: the money is held, not delivered. Contact
              the store.
            </p>
          </EndedStep>
        );
        break;
      case 'refused':
        body = (
          <EndedStep glyph={STOP_GLYPH} title="Not available" alert>
            <p>{REFUSALS.offer_refused}</p>
            <p class="note">{view.message}</p>
          </EndedStep>
        );
        break;
    }
  }

  return (
    <>
      <BannerNote banner={banner} />
      <section class="card" aria-labelledby="store-name" ref={card}>
        <Header
          store={store.current}
          testNetwork={network.current !== undefined && network.current !== 'mainnet'}
        />
        {body}
        <Footer />
      </section>
    </>
  );
}
