import type { Network } from '@elisym/pay-core';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Screen } from './controller';
import type { Banner, StoreInfo, View } from './session';
import { BannerNote } from './ui/BannerNote';
import { ChainGlyph } from './ui/ChainGlyph';
import { isPhone } from './ui/device';
import { DoneStep } from './ui/DoneStep';
import { EndedStep } from './ui/EndedStep';
import { focusFallback } from './ui/focus';
import { Footer } from './ui/Footer';
import { RETURN_GLYPH, STOP_GLYPH } from './ui/glyphs';
import { Header } from './ui/Header';
import { OfferPanel } from './ui/OfferPanel';
import { OldPromptStep } from './ui/OldPromptStep';
import { INITIAL_PANEL, advancePanel, openWallets, shownProblem } from './ui/panel';
import { PayingLine } from './ui/PayingLine';
import { ProductBlock } from './ui/ProductBlock';
import { ProgressStep } from './ui/ProgressStep';
import { REFUSALS, payoutLabel, slowLoading } from './ui/text';

export interface Actions {
  choosePayout(index: number): void;
  confirmOldPrompt(): Promise<void>;
  cancelOldPrompt(): void;
  setEmail(value: string): void;
  pay(walletName: string): Promise<void>;
  retry(walletName: string): Promise<void>;
  startOver(): Promise<void>;
}

/** An action left unanswered this long (a wallet window has no timeout) gets a hint. */
export const HINT_AFTER_MS = 60_000;

interface Props {
  /** Before the purchase session starts: waiting, loading or refused. */
  screen: Screen;
  /** The purchase, once the offer is loaded. */
  view?: View;
  /** A late answer for another order of this product, shown above whatever is on screen. */
  banner?: Banner;
  actions: Actions;
  /** In a modal only: ask the page to close it. */
  onClose?: () => void;
  /** Dev only (the fixture page): the wallet section starts open. */
  initialWalletsOpen?: boolean;
  /** Dev only (the fixture page): the payout list starts open. */
  initialListOpen?: boolean;
  /** How long an unanswered action waits before its hint (the fixture page shows it at once). */
  hintAfterMs?: number;
}

/** The network a view is about, when it says. */
function networkOf(view: View | undefined): Network | undefined {
  if (view === undefined) {
    return undefined;
  }
  switch (view.kind) {
    case 'offer':
      return view.payout.target.caip19.chain.network;
    case 'working':
    case 'waiting_payment':
    case 'waiting_store':
    case 'old_prompt':
      return view.paying?.network;
    default:
      return undefined;
  }
}

/** The store a view names, when it does. */
function storeOf(view: View | undefined): StoreInfo | undefined {
  if (view === undefined) {
    return undefined;
  }
  switch (view.kind) {
    case 'offer': {
      const { profile, level, domain } = view.offer.offer;
      return { name: profile.name, level, ...(domain === undefined ? {} : { domain }) };
    }
    case 'working':
    case 'waiting_payment':
    case 'waiting_store':
    case 'old_prompt':
      return view.about.store;
    default:
      return view.store;
  }
}

/**
 * The checkout card: a header (the store, its trust level), one panel that
 * grows top to bottom as the purchase goes on, and a footer. Store data is
 * rendered as text only; a delivery is a link only when it is `https:`. The
 * session decides what is possible; this only decides what is open and where
 * focus goes after the buyer acts.
 */
export function Checkout({
  screen,
  view,
  banner,
  actions,
  onClose,
  initialWalletsOpen = false,
  initialListOpen = false,
  hintAfterMs = HINT_AFTER_MS,
}: Props) {
  const panel = useRef(
    initialWalletsOpen ? { ...INITIAL_PANEL, walletsOpen: true } : INITIAL_PANEL,
  );
  const seen = useRef<View | undefined>(undefined);
  const email = useRef('');
  const store = useRef<StoreInfo | undefined>(undefined);
  const network = useRef<Network | undefined>(undefined);
  /** A buyer's action is running: the first view it produces takes focus. */
  const armed = useRef(false);
  /** After this render: focus the new section heading, or fall back (`focusFallback`). */
  const focusNext = useRef<'wallets' | 'fallback' | undefined>(undefined);
  /** The element that had focus when a new view arrived: if the view removed it, focus falls back. */
  const focusedBefore = useRef<HTMLElement | null>(null);
  /** A wallet was pressed: the payout and the wallets wait for the next view (or the press to end). */
  const locked = useRef(false);
  const card = useRef<HTMLElement>(null);
  const [, redraw] = useState(0);

  if (view !== seen.current) {
    const active = document.activeElement;
    focusedBefore.current =
      active instanceof HTMLElement && card.current?.contains(active) === true ? active : null;
    seen.current = view;
    panel.current = advancePanel(panel.current, view);
    network.current = networkOf(view) ?? network.current;
    store.current = storeOf(view) ?? store.current;
    locked.current = false;
    if (view?.kind === 'offer') {
      // Reseeded from the session on every offer: what is shown is what is sent.
      email.current = view.email;
    }
    if (armed.current && view !== undefined) {
      armed.current = false;
      focusNext.current = 'fallback';
    }
  }

  useEffect(() => {
    const next = focusNext.current;
    const before = focusedBefore.current;
    focusNext.current = undefined;
    focusedBefore.current = null;
    if (next === 'wallets') {
      // Never pulls focus back once the buyer is elsewhere.
      if (document.hasFocus()) {
        card.current?.querySelector<HTMLElement>('[data-heading]')?.focus({ preventScroll: true });
      }
    } else if (next === 'fallback' || (before !== null && !before.isConnected)) {
      focusFallback(card.current, seen.current);
    }
  });

  const run = (action: () => Promise<void>, lock = false) => {
    armed.current = true;
    if (lock) {
      locked.current = true;
      redraw((count) => count + 1);
    }
    void action().finally(() => {
      armed.current = false;
      if (locked.current) {
        locked.current = false;
        redraw((count) => count + 1);
      }
    });
  };
  const setEmail = (value: string) => {
    email.current = value;
    actions.setEmail(value);
    redraw((count) => count + 1);
  };
  const startOver = () => run(() => actions.startOver());

  let body: ComponentChildren;
  if (view === undefined) {
    if (screen.kind === 'refused') {
      body = (
        <EndedStep glyph={STOP_GLYPH} title="Not available" alert>
          <p>{REFUSALS[screen.reason]}</p>
          {screen.message === undefined ? null : <p class="note">{screen.message}</p>}
        </EndedStep>
      );
    } else {
      body = (
        <>
          <p class="status loading" role="status">
            Loading…
          </p>
          {screen.kind === 'loading' && screen.slow === true ? (
            <p class="note">{slowLoading(onClose !== undefined)}</p>
          ) : null}
        </>
      );
    }
  } else {
    const problem =
      view.kind === 'offer' || view.kind === 'waiting_payment'
        ? shownProblem(panel.current, view.problem)
        : undefined;
    switch (view.kind) {
      case 'offer':
        body = (
          <OfferPanel
            view={view}
            problem={problem}
            email={email.current}
            onEmail={setEmail}
            walletsOpen={panel.current.walletsOpen}
            onOpenWallets={() => {
              panel.current = openWallets(panel.current, view.problem);
              focusNext.current = 'wallets';
              redraw((count) => count + 1);
            }}
            onChoosePayout={actions.choosePayout}
            onPay={(name) => run(() => actions.pay(name), true)}
            phone={isPhone(navigator.userAgent)}
            locked={locked.current}
            initialListOpen={initialListOpen}
          />
        );
        break;
      case 'working':
      case 'waiting_payment':
      case 'waiting_store':
        body = (
          <>
            <ProductBlock product={view.about.product} />
            <PayingLine paying={view.paying} />
            {view.about.email === undefined ? null : (
              <p class="sent-email">
                <span class="label">Email</span> {view.about.email}
              </p>
            )}
            <ProgressStep
              view={view}
              problem={problem}
              onRetry={(name) => run(() => actions.retry(name))}
              onStartOver={startOver}
              hintAfterMs={hintAfterMs}
            />
          </>
        );
        break;
      case 'old_prompt':
        body = (
          <>
            <ProductBlock product={view.about.product} />
            {view.paying === undefined ? null : (
              <p class="pay-label">
                <ChainGlyph chain={view.paying.chain} />
                <span>{payoutLabel(view.paying)}</span>
              </p>
            )}
            <OldPromptStep
              view={view}
              onContinue={() => run(() => actions.confirmOldPrompt())}
              onBack={actions.cancelOldPrompt}
            />
          </>
        );
        break;
      case 'delivered':
        body = <DoneStep view={view} onBuyAgain={startOver} onDone={onClose} />;
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
