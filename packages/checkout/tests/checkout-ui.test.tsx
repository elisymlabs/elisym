// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReadyOffer,
  aboutOf,
  cannedOffer,
  cannedSource,
  offerView,
  waitingView,
} from '../scripts/fixtures/canned';
import { type Actions, Checkout, FINISH_FILL_MS, FINISH_WAIT_MS } from '../src/app/Checkout';
import type { Screen } from '../src/app/controller';
import type { Banner, Paying, Problem, Receipt, View } from '../src/app/session';
import { SOLD_OUT_GLYPH } from '../src/app/ui/glyphs';
import { PROBLEM_PLACE } from '../src/app/ui/panel';
import type { PurchasesSource } from '../src/app/ui/PurchasesStep';
import { STEPPER_STAGES, receiptText as fullReceiptText } from '../src/app/ui/text';

interface Calls {
  pay: string[];
  retry: string[];
  startOver: number;
  choose: number[];
  email: string[];
  oldPromptBack: number;
  cancel: number;
}

interface DrawProps {
  view?: View;
  banner?: Banner;
  onClose?: () => void;
  screen?: Screen;
  resetCount?: number;
}

interface MountOptions {
  refused?: boolean;
  hintAfterMs?: number;
  cancelDraws?: View;
  reducedMotion?: () => boolean;
  finishWaitMs?: number;
  finishFillMs?: number;
  purchases?: PurchasesSource;
}

/** A stage's name, without the hidden ", done" / ", current" that says its state. */
function stageName(stage: Element | null | undefined): string | undefined {
  if (stage === null || stage === undefined) {
    return undefined;
  }
  const copy = stage.cloneNode(true);
  if (!(copy instanceof Element)) {
    return undefined;
  }
  for (const hidden of copy.querySelectorAll('.visually-hidden')) {
    hidden.remove();
  }
  return copy.textContent ?? '';
}

/** The copy button's label on screen (the others in its cell are hidden). */
function currentLabel(ui: { container: HTMLElement }): string | undefined {
  return ui.container.querySelector('.label-option[data-current="true"]')?.textContent ?? undefined;
}

/** A `Checkout` in the page, with actions that record what they were asked. */
function mount(view?: View, options: MountOptions = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const calls: Calls = {
    pay: [],
    retry: [],
    startOver: 0,
    choose: [],
    email: [],
    oldPromptBack: 0,
    cancel: 0,
  };
  /** What the next action resolves with; a test may hold it open. */
  let settle: Promise<void> = Promise.resolve();
  const actions: Actions = {
    choosePayout: (index) => calls.choose.push(index),
    confirmOldPrompt: async () => undefined,
    cancelOldPrompt: () => {
      calls.oldPromptBack += 1;
    },
    setEmail: (value) => calls.email.push(value),
    pay: (name) => {
      calls.pay.push(name);
      return settle;
    },
    retry: (name) => {
      calls.retry.push(name);
      return settle;
    },
    startOver: () => {
      calls.startOver += 1;
      return settle;
    },
    cancel: () => {
      calls.cancel += 1;
      // As the session does: the view it brings back is drawn at once.
      if (options.cancelDraws !== undefined) {
        draw({ view: options.cancelDraws });
      }
    },
  };
  let props: DrawProps = {
    ...(view === undefined ? {} : { view }),
    screen:
      options.refused === true ? { kind: 'refused', reason: 'no_storage' } : { kind: 'loading' },
  };
  const draw = (next: DrawProps) => {
    props = { ...props, ...next };
    act(() => {
      render(
        <Checkout
          screen={props.screen ?? { kind: 'loading' }}
          {...(props.view === undefined ? {} : { view: props.view })}
          {...(props.banner === undefined ? {} : { banner: props.banner })}
          {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
          {...(options.hintAfterMs === undefined ? {} : { hintAfterMs: options.hintAfterMs })}
          {...(props.resetCount === undefined ? {} : { resetCount: props.resetCount })}
          {...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion })}
          {...(options.finishWaitMs === undefined ? {} : { finishWaitMs: options.finishWaitMs })}
          {...(options.finishFillMs === undefined ? {} : { finishFillMs: options.finishFillMs })}
          {...(options.purchases === undefined ? {} : { purchases: options.purchases })}
          actions={actions}
        />,
        container,
      );
    });
  };
  draw({});
  const buttons = () => [...container.querySelectorAll('button')];
  const button = (label: string) => {
    const found = buttons().find((each) => each.textContent?.includes(label) === true);
    if (found === undefined) {
      throw new Error(`no button "${label}" in: ${container.textContent ?? ''}`);
    }
    return found;
  };
  return {
    container,
    calls,
    draw,
    buttons,
    button,
    hold: (promise: Promise<void>) => {
      settle = promise;
    },
    click: (label: string) => act(() => button(label).click()),
    has: (selector: string) => container.querySelector(selector) !== null,
    walletsOpen: () => container.querySelector('[data-step="wallets"]') !== null,
    text: () => container.textContent ?? '',
    status: () =>
      [...container.querySelectorAll('[role="status"]')].map((each) => each.textContent ?? ''),
    alerts: () =>
      [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent ?? ''),
  };
}

type Ui = ReturnType<typeof mount>;

/** Each stage's state, in order. */
function stageStates(ui: Ui): (string | null)[] {
  return [...ui.container.querySelectorAll('.stepper li')].map((stage) =>
    stage.getAttribute('data-state'),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The wallets show at once on the first offer (D5). */
function withWallets(view: View): Ui {
  const ui = mount(view);
  expect(ui.walletsOpen()).toBe(true);
  return ui;
}

function withPrice(offer: ReadyOffer, amount: string, extra: bigint): ReadyOffer {
  return {
    ...offer,
    offer: {
      ...offer.offer,
      product: { ...offer.offer.product, price: { amount, currency: 'USD' } },
    },
    payouts: offer.payouts.map((payout) => ({ ...payout, amount: payout.amount + extra })),
  };
}

function key(target: Element, type: 'keydown' | 'keyup', name: string): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const OFFER_PROBLEMS: Problem[] = [
  { reason: 'offer_changed' },
  { reason: 'bad_email' },
  { reason: 'offer_refused' },
  { reason: 'sold_out' },
  { reason: 'other_purchase' },
  { reason: 'too_late' },
];

const WALLET_PROBLEMS: Problem[] = [
  { reason: 'no_wallet' },
  { reason: 'rpc_error' },
  { reason: 'clock_skew' },
  { reason: 'wrong_chain' },
  { reason: 'rejected' },
  { reason: 'insufficient_token', needed: 49_000_000n, available: 1n },
  { reason: 'insufficient_sol', needed: 5000n, available: 0n },
  { reason: 'self_payment' },
  { reason: 'order_not_acknowledged' },
  { reason: 'no_store_inbox' },
  { reason: 'failed' },
  { reason: 'policy_blocked' },
  { reason: 'late_approval' },
];

const asset = USDC_SOLANA_DEVNET;
const paying: Paying = { amount: '55000000', asset, network: 'devnet', chain: 'solana' };
const tempoPaying: Paying = {
  amount: '49000000',
  asset,
  network: 'devnet',
  chain: 'tempo',
};
const about = aboutOf(cannedOffer());

describe('the panel rule', () => {
  it('places exactly the offer-level problems on the offer', () => {
    const offerClass = Object.entries(PROBLEM_PLACE)
      .filter(([, place]) => place === 'offer')
      .map(([reason]) => reason);
    expect(offerClass.sort()).toEqual(OFFER_PROBLEMS.map((problem) => problem.reason).sort());
  });

  it('shows the wallets at once below the offer, hiding nothing above them (D5, M16)', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] })));
    expect(ui.walletsOpen()).toBe(true);
    expect(ui.container.querySelector('.product-title')?.textContent).toBe('Agents 101');
    expect(ui.container.querySelector('.price')?.textContent).toBe('49 USD');
    expect(ui.has('button.select')).toBe(true);
    expect(ui.buttons().some((each) => each.textContent === 'Choose wallet')).toBe(false);
    expect(ui.buttons().some((each) => each.textContent?.includes('Back') === true)).toBe(false);
    expect(ui.text()).not.toContain('tick');
    expect(ui.has('input[type="checkbox"]')).toBe(false);
  });

  for (const problem of OFFER_PROBLEMS) {
    it(`closes the wallets for a new ${problem.reason}, and shows it on the offer`, () => {
      const offer = cannedOffer();
      const ui = withWallets(offerView(offer, { askEmail: true }));
      ui.draw({ view: offerView(offer, { askEmail: true, problem }) });
      expect(ui.walletsOpen()).toBe(false);
      expect(ui.alerts()).toHaveLength(1);
    });
  }

  it('after a declined retry, shows the decline among the wallets', () => {
    const offer = cannedOffer();
    const ui = mount(waitingView(about, paying, { canRetry: true }));
    ui.draw({ view: offerView(offer, { problem: { reason: 'rejected' } }) });
    expect(ui.walletsOpen()).toBe(true);
    const section = ui.container.querySelector('[data-step="wallets"]');
    expect(section?.textContent).toContain('You declined in the wallet');
    expect(ui.buttons().some((each) => each.textContent === 'Choose wallet')).toBe(false);
  });

  for (const problem of WALLET_PROBLEMS) {
    it(`keeps the wallets open and shows ${problem.reason} among them`, () => {
      const offer = cannedOffer();
      const ui = withWallets(offerView(offer));
      ui.draw({ view: { kind: 'working', step: 'checking', about } });
      ui.draw({ view: offerView(offer, { problem }) });
      expect(ui.walletsOpen()).toBe(true);
      const section = ui.container.querySelector('[data-step="wallets"]');
      expect(section?.querySelectorAll('[role="alert"]')).toHaveLength(1);
    });
  }

  it('shows a wallet problem above the button while a review keeps the wallets closed', () => {
    const offer = cannedOffer({ payouts: ['tempo-devnet'] });
    const ui = mount(offerView(offer, { problem: { reason: 'offer_changed' } }));
    expect(ui.walletsOpen()).toBe(false);
    ui.draw({ view: offerView(offer, { problem: { reason: 'attempt_over' } }) });
    expect(ui.walletsOpen()).toBe(false);
    expect(ui.alerts().join(' ')).toContain('reject it');
    expect(ui.button('Choose wallet')).toBeDefined();
  });

  it('keeps the wallets open on a reload that changed nothing, then a network error', () => {
    const ui = withWallets(offerView(cannedOffer()));
    ui.draw({ view: { kind: 'working', step: 'checking', about } });
    // A fresh snapshot: new objects, the same values.
    ui.draw({ view: offerView(cannedOffer(), { problem: { reason: 'rpc_error' } }) });
    expect(ui.walletsOpen()).toBe(true);
    expect(ui.text()).toContain('The network could not be reached');
  });

  it('closes the wallets and shows the new price when the store changed the offer', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.draw({
      view: offerView(withPrice(offer, '55', 6_000_000n), { problem: { reason: 'offer_changed' } }),
    });
    expect(ui.walletsOpen()).toBe(false);
    expect(ui.container.querySelector('.price')?.textContent).toBe('55 USD');
  });

  it('keeps the wallets open when the buyer picks another payout, with that chain’s wallets', () => {
    const offer = cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] });
    const ui = withWallets(offerView(offer));
    ui.draw({
      view: offerView(offer, { payoutIndex: 1, wallets: [{ name: 'MetaMask' }] }),
    });
    expect(ui.walletsOpen()).toBe(true);
    // A Tempo wallet row is the wallet's name, nothing else: the wallet asks to switch itself.
    const row = ui.container.querySelector('.wallet-row .wallet-name');
    expect(row?.textContent).toBe('MetaMask');
    expect(ui.text()).not.toContain('switches to Tempo');
  });

  it('starts with the wallets on the offer after a payment ended back on it (M18)', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { problem: { reason: 'offer_changed' } }));
    expect(ui.walletsOpen()).toBe(false);
    ui.draw({ view: waitingView(about, paying, { canRetry: true }) });
    ui.draw({ view: offerView(offer) });
    expect(ui.walletsOpen()).toBe(true);
  });

  it('opens the wallets again after Buy again, and a review problem closes them (M17)', () => {
    const offer = cannedOffer();
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    ui.draw({ view: offerView(offer) });
    expect(ui.walletsOpen()).toBe(true);
    ui.draw({ view: offerView(offer, { problem: { reason: 'offer_changed' } }) });
    expect(ui.walletsOpen()).toBe(false);
    ui.click('Choose wallet');
    expect(ui.walletsOpen()).toBe(true);
  });

  it('keeps the wallets open when one registers, and never shows a problem moved on from', () => {
    const offer = cannedOffer();
    const problem: Problem = { reason: 'offer_changed' };
    const ui = mount(offerView(offer, { problem }));
    expect(ui.alerts()).toHaveLength(1);
    ui.click('Choose wallet');
    // `refresh()`: a new view, the same problem object.
    ui.draw({ view: offerView(offer, { problem, wallets: [{ name: 'Backpack' }] }) });
    expect(ui.walletsOpen()).toBe(true);
    expect(ui.alerts()).toHaveLength(0);
    expect(ui.text()).toContain('Backpack');
  });

  it('keeps the wallets open across the old-prompt question', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.draw({ view: { kind: 'working', step: 'checking', about } });
    ui.draw({ view: { kind: 'old_prompt', orders: 1, until: 0, about } });
    ui.draw({ view: offerView(offer) });
    expect(ui.walletsOpen()).toBe(true);
  });
});

describe('the payout dropdown', () => {
  const many = () => offerView(cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] }));
  const select = (ui: Ui) => ui.container.querySelector('button.select') as HTMLButtonElement;
  const list = (ui: Ui) => ui.container.querySelector('[role="listbox"]');
  const options = (ui: Ui) => [...ui.container.querySelectorAll('[role="option"]')];

  it('is a label, not a control, for a single payout', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['solana-mainnet'] })));
    expect(ui.container.querySelector('.pay-label')?.textContent).toBe('USDC · Solana');
    expect(ui.has('[aria-haspopup="listbox"]')).toBe(false);
  });

  it('names the payout chosen and opens with ArrowDown, focus in the list', () => {
    const ui = mount(many());
    expect(select(ui).textContent).toBe('USDC · Solana devnet');
    expect(select(ui).getAttribute('aria-expanded')).toBe('false');
    expect(list(ui)).toBeNull();
    const down = key(select(ui), 'keydown', 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(select(ui).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(list(ui));
    expect(options(ui).map((option) => option.textContent)).toEqual([
      'USDC · Solana devnet',
      'pathUSD · Tempo devnet',
    ]);
    expect(options(ui)[0]?.getAttribute('aria-selected')).toBe('true');
    expect(list(ui)?.getAttribute('aria-activedescendant')).toBe(options(ui)[0]?.id);
  });

  it('opens on Enter as a browser does it: the key, then the button’s own click', () => {
    const ui = mount(many());
    select(ui).focus();
    key(select(ui), 'keydown', 'Enter');
    act(() => select(ui).click());
    expect(select(ui).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(list(ui));
  });

  it('moves with the arrows, Home and End, and chooses on Enter', () => {
    const ui = mount(many());
    key(select(ui), 'keydown', 'ArrowDown');
    const box = list(ui) as HTMLElement;
    key(box, 'keydown', 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(options(ui)[1]?.id);
    key(box, 'keydown', 'Home');
    expect(box.getAttribute('aria-activedescendant')).toBe(options(ui)[0]?.id);
    key(box, 'keydown', 'End');
    const enter = key(box, 'keydown', 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(ui.calls.choose).toEqual([1]);
    expect(list(ui)).toBeNull();
    expect(document.activeElement).toBe(select(ui));
  });

  it('chooses with Space on its release, never on its press', () => {
    const ui = mount(many());
    key(select(ui), 'keydown', 'ArrowDown');
    const box = list(ui) as HTMLElement;
    key(box, 'keydown', 'ArrowDown');
    const press = key(box, 'keydown', ' ');
    expect(press.defaultPrevented).toBe(true);
    expect(ui.calls.choose).toEqual([]);
    key(box, 'keyup', ' ');
    expect(ui.calls.choose).toEqual([1]);
    expect(document.activeElement).toBe(select(ui));
  });

  it('closes on Escape without choosing, and keeps that Escape from the modal', () => {
    const ui = mount(many());
    key(select(ui), 'keydown', 'ArrowDown');
    const escape = key(list(ui) as HTMLElement, 'keydown', 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(list(ui)).toBeNull();
    expect(ui.calls.choose).toEqual([]);
    expect(document.activeElement).toBe(select(ui));
  });

  it('takes focus when opened by a click, so Escape there closes only the list', () => {
    const ui = mount(many());
    act(() => select(ui).click());
    expect(document.activeElement).toBe(list(ui));
    const escape = key(list(ui) as HTMLElement, 'keydown', 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(list(ui)).toBeNull();
  });

  it('closes on Tab, from the button, letting the Tab go on', () => {
    const ui = mount(many());
    key(select(ui), 'keydown', 'ArrowDown');
    const tab = key(list(ui) as HTMLElement, 'keydown', 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(list(ui)).toBeNull();
    expect(document.activeElement).toBe(select(ui));
  });

  it('closes on a press outside it, and on its own button', () => {
    const ui = mount(many());
    act(() => select(ui).click());
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(list(ui)).toBeNull();
    act(() => select(ui).click());
    expect(document.activeElement).toBe(list(ui));
    act(() => select(ui).click());
    expect(list(ui)).toBeNull();
    expect(document.activeElement).toBe(select(ui));
  });

  it('keeps focus on its button after a choice, with the wallets open', () => {
    const offer = cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] });
    const ui = withWallets(offerView(offer));
    act(() => select(ui).click());
    act(() => (options(ui)[1] as HTMLElement).click());
    expect(ui.calls.choose).toEqual([1]);
    ui.draw({ view: offerView(offer, { payoutIndex: 1, wallets: [{ name: 'MetaMask' }] }) });
    expect(document.activeElement).toBe(select(ui));
    key(select(ui), 'keydown', 'ArrowUp');
    key(list(ui) as HTMLElement, 'keydown', 'Enter');
    ui.draw({ view: offerView(offer, { payoutIndex: 0 }) });
    expect(document.activeElement).toBe(select(ui));
  });

  it('is locked from a wallet press until the next view, or until the press ends', async () => {
    const offer = cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] });
    const ui = withWallets(offerView(offer));
    let finish: () => void = () => undefined;
    ui.hold(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    ui.click('Phantom');
    expect(select(ui).getAttribute('aria-disabled')).toBe('true');
    act(() => select(ui).click());
    expect(list(ui)).toBeNull();
    ui.draw({ view: offerView(offer, { problem: { reason: 'rpc_error' } }) });
    expect(select(ui).getAttribute('aria-disabled')).toBe('false');
    // A press that draws nothing: unlocked when it ends.
    ui.hold(Promise.resolve());
    await act(async () => ui.button('Phantom').click());
    expect(select(ui).getAttribute('aria-disabled')).toBe('false');
    finish();
  });

  it('an open list locked by a wallet press does not come back open', () => {
    const offer = cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] });
    const ui = withWallets(offerView(offer));
    key(select(ui), 'keydown', 'ArrowDown');
    expect(list(ui)).not.toBeNull();
    ui.hold(new Promise<void>(() => undefined));
    // A screen reader's click, with no pointerdown before it.
    ui.click('Phantom');
    expect(list(ui)).toBeNull();
    ui.draw({ view: offerView(offer, { problem: { reason: 'no_wallet' } }) });
    expect(select(ui).getAttribute('aria-disabled')).toBe('false');
    expect(list(ui)).toBeNull();
    expect(select(ui).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the email', () => {
  const input = (ui: Ui) => ui.container.querySelector('input[type="email"]') as HTMLInputElement;

  it('keeps what was typed above the wallets', () => {
    const ui = mount(offerView(cannedOffer(), { askEmail: true }));
    act(() => {
      input(ui).value = 'buyer@example.com';
      input(ui).dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ui.walletsOpen()).toBe(true);
    expect(input(ui).value).toBe('buyer@example.com');
    expect(ui.calls.email.at(-1)).toBe('buyer@example.com');
  });

  it('is reseeded from the session on every offer', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true, email: 'a@example.com' }));
    ui.draw({ view: { kind: 'working', step: 'checking', about } });
    ui.draw({
      view: offerView(offer, {
        askEmail: true,
        email: 'a@example.com',
        problem: { reason: 'rpc_error' },
      }),
    });
    expect(input(ui).value).toBe('a@example.com');
  });

  it('shows a mistyped email at the field', () => {
    const ui = mount(
      offerView(cannedOffer(), { askEmail: true, problem: { reason: 'bad_email' } }),
    );
    const field = ui.container.querySelector('.field');
    expect(field?.nextElementSibling?.textContent).toContain('That email does not look right');
  });

  it('is always the same field, labelled for the store', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true }));
    expect(input(ui)).not.toBeNull();
    expect(ui.text()).toContain('Email for the store (optional)');
    expect(ui.text()).not.toContain('earlier order');
  });

  it('is shown read-only during a payment, only when this session sent it', () => {
    const ui = mount({ kind: 'working', step: 'signing', paying, about });
    expect(input(ui)).toBeNull();
    expect(ui.has('button.select')).toBe(false);
    expect(ui.has('.sent-email')).toBe(false);
    ui.draw({
      view: {
        kind: 'working',
        step: 'signing',
        paying,
        about: aboutOf(cannedOffer(), 'buyer@example.com'),
      },
    });
    expect(ui.container.querySelector('.sent-email')?.textContent).toContain('buyer@example.com');
    expect(input(ui)).toBeNull();
  });
});

describe('the wallets', () => {
  it('pay with the wallet clicked', () => {
    const ui = withWallets(offerView(cannedOffer()));
    ui.click('Solflare');
    expect(ui.calls.pay).toEqual(['Solflare']);
  });

  it('show an icon only when it is inlined', () => {
    const ui = withWallets(
      offerView(cannedOffer(), {
        wallets: [
          { name: 'Inline', icon: 'data:image/png;base64,AAAA' },
          { name: 'Remote', icon: 'https://wallet.example/icon.png' },
        ],
      }),
    );
    const images = [...ui.container.querySelectorAll('.wallet-icon')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,AAAA',
    ]);
    expect(ui.container.querySelector('.monogram')?.textContent).toBe('R');
  });

  it('link the Solana wallets to install when none is found', () => {
    const ui = withWallets(offerView(cannedOffer(), { wallets: [] }));
    const links = [...ui.container.querySelectorAll('.install a')];
    expect(links.map((link) => link.textContent)).toEqual(['Phantom', 'Solflare']);
    for (const link of links) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');
    }
    expect(ui.text()).toContain('Reload this page after installing');
  });

  it('name MetaMask for Tempo, when none is found and when a wallet failed', () => {
    const offer = cannedOffer({ payouts: ['tempo-devnet'] });
    const ui = withWallets(offerView(offer, { wallets: [] }));
    expect(
      [...ui.container.querySelectorAll('.install a')].map((link) => link.textContent),
    ).toEqual(['MetaMask']);
    ui.draw({
      view: offerView(offer, { wallets: [{ name: 'Other' }], problem: { reason: 'no_wallet' } }),
    });
    expect(ui.alerts().join(' ')).toContain('MetaMask is known to work');
    ui.draw({
      view: offerView(offer, {
        wallets: [{ name: 'Other' }],
        problem: { reason: 'tempo_unsupported' },
      }),
    });
    expect(ui.walletsOpen()).toBe(true);
    expect(ui.alerts().join(' ')).toContain(
      'This wallet cannot pay on Tempo. Choose another wallet.',
    );
    expect(ui.alerts().join(' ')).toContain('MetaMask is known to work');
  });

  it('send a phone on Tempo to MetaMask’s in-app browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    );
    const ui = withWallets(offerView(cannedOffer({ payouts: ['tempo-devnet'] }), { wallets: [] }));
    expect(ui.text()).toContain('Open this page in MetaMask’s in-app browser.');
  });

  it('send a phone to its wallet app’s browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    );
    const ui = withWallets(offerView(cannedOffer(), { wallets: [] }));
    expect(ui.text()).toContain('Open this page in your wallet app’s browser');
    expect(ui.has('.install')).toBe(false);
  });

  it('show a Test network badge on devnet only', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['tempo-devnet'] })));
    expect(ui.text()).toContain('Test network');
    ui.draw({ view: offerView(cannedOffer({ payouts: ['tempo-mainnet'] })) });
    expect(ui.text()).not.toContain('Test network');
  });
});

/** The unanswered-wallet hint's lines, and what its live region says. */
function unanswered(ui: Ui): { lines: string[]; spoken: string | undefined } {
  return {
    lines: [...ui.container.querySelectorAll('p.hint')].map((line) => line.textContent ?? ''),
    spoken: ui.container.querySelector('[data-unanswered-status]')?.textContent ?? undefined,
  };
}

const REJECT_LINE = 'If you do not want to pay, reject the request in your wallet.';

describe('the wallet has not answered a payment request (D7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('U-i Solana: nothing for 10 s, then when Start over opens, its countdown, then the check', () => {
    vi.useFakeTimers();
    const signing: View = { kind: 'working', step: 'signing', paying, about };
    const ui = mount(signing);
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(ui.has('.hint')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(unanswered(ui).lines).toEqual([
      'Your wallet has not answered. You can start over once the request expires.',
      REJECT_LINE,
    ]);
    // The probe's countdown arrives: a redraw of the same step keeps the hint up.
    const now = Math.floor(Date.now() / 1000);
    ui.draw({
      view: { ...signing, startOverIn: { seconds: 65, at: now }, unsureAt: now + 600 },
    });
    expect(unanswered(ui).lines).toEqual([
      'Your wallet has not answered. You can start over in 1:05.',
      REJECT_LINE,
    ]);
    expect(ui.container.querySelector('p.hint .countdown')?.textContent).toBe('1:05');
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(unanswered(ui).lines).toEqual([
      'Checking whether the request has expired…',
      REJECT_LINE,
    ]);
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(unanswered(ui).lines).toEqual([
      'This is taking long. If it does not resolve, contact the store.',
      REJECT_LINE,
    ]);
    expect(ui.buttons().some((each) => each.textContent === 'Cancel')).toBe(false);
    expect(ui.text()).not.toContain('reload the page');
  });

  it('U-i Tempo: its own words, and a countdown still running is never "taking long" (M55)', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const signing: View = {
      kind: 'working',
      step: 'signing',
      paying: tempoPaying,
      about,
      // About 11 minutes in: past `unsureAt` (setAt + 10 min), long before the
      // request's late deadline (about 40 min after it was made).
      unsureAt: now - 60,
    };
    const ui = mount(signing);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // No countdown yet, past `unsureAt`: taking long.
    expect(unanswered(ui).lines[0]).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
    const later = Math.floor(Date.now() / 1000);
    ui.draw({ view: { ...signing, startOverIn: { seconds: 29 * 60, at: later } } });
    expect(unanswered(ui).lines).toEqual([
      'Your wallet has not answered. You can start over in 29:00.',
      REJECT_LINE,
    ]);
    expect(unanswered(ui).spoken).toBe(
      'Your wallet has not answered. Start over opens when the checkout stops waiting for it.',
    );
    act(() => {
      vi.advanceTimersByTime(29 * 60_000);
    });
    // The countdown reached 0: the docs' sequence, countdown -> checking -> taking long.
    expect(unanswered(ui).lines).toEqual([
      'Checking whether the request was approved…',
      REJECT_LINE,
    ]);
    expect(unanswered(ui).spoken).toBe('Checking whether the request was approved…');
    act(() => {
      vi.advanceTimersByTime(600_000 - 1_000);
    });
    expect(unanswered(ui).lines[0]).toBe('Checking whether the request was approved…');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(unanswered(ui).lines[0]).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
    expect(unanswered(ui).spoken).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
    ui.draw({ view: { ...signing, unsureAt: later + 3600 } });
    expect(unanswered(ui).lines[0]).toBe(
      'Your wallet has not answered. You can start over once the checkout stops waiting for it.',
    );
    expect(ui.text()).not.toContain('reload the page');
  });

  it('U-i Solana: a countdown at 0 says checking even past unsureAt, taking long only after UNSURE_AFTER_SECS more', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const ui = mount({
      kind: 'working',
      step: 'signing',
      paying,
      about,
      // The countdown ended 5 minutes ago and `unsureAt` already passed.
      startOverIn: { seconds: 0, at: now - 300 },
      unsureAt: now - 30,
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(unanswered(ui).lines).toEqual([
      'Checking whether the request has expired…',
      REJECT_LINE,
    ]);
    expect(unanswered(ui).spoken).toBe('Checking whether the request has expired…');
    act(() => {
      vi.advanceTimersByTime(289_000);
    });
    expect(unanswered(ui).lines[0]).toBe('Checking whether the request has expired…');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(unanswered(ui).lines[0]).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
    expect(unanswered(ui).spoken).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
  });

  it('U-j the live region speaks once per phase, never the ticking number (M19)', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const ui = mount({
      kind: 'working',
      step: 'signing',
      paying,
      about,
      startOverIn: { seconds: 20, at: now },
      unsureAt: now + 600,
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const counting = unanswered(ui).spoken;
    expect(counting).toBe(
      'Your wallet has not answered. Start over opens when the request expires.',
    );
    for (let tick = 0; tick < 9; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(unanswered(ui).spoken).toBe(counting);
    }
    // The countdown sits outside every live region.
    for (const live of ui.container.querySelectorAll('[role="status"], [aria-live]')) {
      expect(live.querySelector('.countdown')).toBeNull();
    }
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(unanswered(ui).spoken).toBe('Checking whether the request has expired…');
  });

  it('says it is taking long from exactly unsureAt, not a second later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_750_000_000_000);
    const now = Math.floor(Date.now() / 1000);
    const ui = mount({ kind: 'working', step: 'signing', paying, about, unsureAt: now + 20 });
    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(unanswered(ui).lines[0]).toBe(
      'Your wallet has not answered. You can start over once the request expires.',
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(Math.floor(Date.now() / 1000)).toBe(now + 20);
    expect(unanswered(ui).lines[0]).toBe(
      'This is taking long. If it does not resolve, contact the store.',
    );
  });

  it('a Tempo request with no countdown yet announces its own words', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'signing', paying: tempoPaying, about });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(unanswered(ui).spoken).toBe(
      'Your wallet has not answered. Start over opens when the checkout stops waiting for it.',
    );
  });
});

describe('the earlier-payment line (D5, R-h)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function lineOf(ui: Ui): { text: string; spoken: string | undefined } {
    const note = ui.container.querySelector('[data-problem-note]');
    const spoken = note?.querySelector('[data-earlier-status]')?.textContent ?? undefined;
    return { text: note?.querySelector('p')?.textContent ?? '', spoken };
  }

  const cases: [Problem, string, string][] = [
    [
      { reason: 'earlier_payment', phase: 'confirming' },
      'A payment from earlier is still being confirmed. Try again in a moment.',
      'A payment from earlier is still being confirmed.',
    ],
    [
      { reason: 'earlier_payment', phase: 'tempo_request' },
      'Your wallet already has a request open. Answer or reject it there, or try again in a moment.',
      'Your wallet already has a request open.',
    ],
    [
      { reason: 'earlier_payment', phase: 'waiting_store' },
      'Your earlier payment arrived and is waiting for the store. It shows under Your purchases.',
      'Your earlier payment arrived and is waiting for the store. It shows under Your purchases.',
    ],
    [
      { reason: 'earlier_payment', phase: 'waiting_store', cancelled: true },
      'Your earlier payment arrived, but the store cancelled the order. It shows under Your purchases.',
      'Your earlier payment arrived, but the store cancelled the order. It shows under Your purchases.',
    ],
  ];
  for (const [problem, text, spoken] of cases) {
    it(`says "${text}"`, () => {
      const ui = mount(offerView(cannedOffer(), { problem }));
      expect(lineOf(ui)).toEqual({ text, spoken });
      expect(ui.alerts()).toEqual([]);
      expect(ui.walletsOpen()).toBe(true);
    });
  }

  for (const phase of ['confirming', 'tempo_request'] as const) {
    it(`counts down (${phase}) without a live-region change, then says "in a moment"`, () => {
      vi.useFakeTimers();
      const now = Math.floor(Date.now() / 1000);
      const ui = mount(
        offerView(cannedOffer(), {
          problem: { reason: 'earlier_payment', phase, retryIn: { seconds: 75, at: now } },
        }),
      );
      const before = lineOf(ui);
      expect(before.text).toBe(
        phase === 'confirming'
          ? 'A payment from earlier is still being confirmed. You can try again in 1:15.'
          : 'Your wallet already has a request open. Answer or reject it there, or try again in 1:15.',
      );
      for (let tick = 0; tick < 10; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(lineOf(ui).spoken).toBe(before.spoken);
      }
      expect(lineOf(ui).text).toContain('1:05');
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(lineOf(ui).text).toContain('in a moment.');
      expect(lineOf(ui).spoken).toBe(before.spoken);
    });
  }

  it('never fades in on its own inside the wallet step, which already does', () => {
    const ui = mount(
      offerView(cannedOffer(), { problem: { reason: 'earlier_payment', phase: 'confirming' } }),
    );
    const note = ui.container.querySelector('[data-problem-note]');
    expect(note?.closest('.step')).not.toBeNull();
    expect(note?.classList.contains('problem')).toBe(true);
    expect(note?.classList.contains('reveal')).toBe(false);
  });

  it('clears when the session draws the offer without it', () => {
    const offer = cannedOffer();
    const ui = mount(
      offerView(offer, { problem: { reason: 'earlier_payment', phase: 'confirming' } }),
    );
    expect(ui.has('[data-earlier-status]')).toBe(true);
    ui.draw({ view: offerView(offer) });
    expect(ui.has('[data-earlier-status]')).toBe(false);
  });
});

describe('progress', () => {
  it('names the product and the exact payment, read-only, in place of the choice', () => {
    const ui = mount({ kind: 'working', step: 'signing', paying, about });
    expect(ui.text()).toContain('Confirm the payment in your wallet');
    expect(ui.container.querySelector('.product-title')?.textContent).toBe('Agents 101');
    expect(ui.container.querySelector('.paying')?.textContent).toBe(
      'Paying 55 USDC · Solana devnet',
    );
    expect(stageName(ui.container.querySelector('[aria-current="step"]'))).toBe(
      'Confirm in wallet',
    );
  });

  it('names the store and the product of a payment resumed after a reload', () => {
    const ui = mount(waitingView(aboutOf(cannedOffer({ name: 'Resumed Shop' })), paying));
    expect(ui.container.querySelector('.store-name')?.textContent).toBe('Resumed Shop');
    expect(ui.container.querySelector('.product-title')?.textContent).toBe('Agents 101');
  });

  it('shows no trust chip for a store named from an order’s old snapshot', () => {
    const ui = mount(waitingView({ ...about, store: { name: 'Demo Shop' } }, paying));
    expect(ui.container.querySelector('.store-name')?.textContent).toBe('Demo Shop');
    expect(ui.has('.chip')).toBe(false);
  });

  it('says what to do when a check has not answered for a while (checking waits 60 s)', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'checking', paying, about });
    expect(ui.has('.hint')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(ui.has('.hint')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(ui.container.querySelector('.hint')?.textContent).toBe(
      'This is taking long. Reload the page to try again; no new payment request has been sent to your wallet.',
    );
  });

  it('offers Cancel while the wallet has not answered its connect request, and says so', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'checking', paying, about, cancellable: true });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(ui.container.querySelector('.hint')?.textContent).toBe(
      'Your wallet has not answered. Answer it, or cancel and choose again.',
    );
    ui.click('Cancel');
    expect(ui.calls.cancel).toBe(1);
  });

  it('a check that stops being cancellable waits the full hint delay again from the flip', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'checking', paying, about, cancellable: true });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(ui.has('.hint')).toBe(false);
    // The wallet answered its connect request: same step, no longer cancellable.
    ui.draw({ view: { kind: 'working', step: 'checking', paying, about } });
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(ui.has('.hint')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(ui.container.querySelector('.hint')?.textContent).toBe(
      'This is taking long. Reload the page to try again; no new payment request has been sent to your wallet.',
    );
  });

  it('has no Cancel once the wallet answered (checking, ordering, signing)', () => {
    const ui = mount({ kind: 'working', step: 'checking', paying, about });
    expect(ui.buttons().some((each) => each.textContent === 'Cancel')).toBe(false);
    for (const step of ['ordering', 'signing'] as const) {
      ui.draw({ view: { kind: 'working', step, paying, about } });
      expect(ui.buttons().some((each) => each.textContent === 'Cancel')).toBe(false);
    }
  });

  it('a cancelled press ending late never unlocks the press that followed it', async () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer), { cancelDraws: offerView(offer) });
    let endFirst: () => void = () => undefined;
    ui.hold(
      new Promise<void>((resolve) => {
        endFirst = resolve;
      }),
    );
    ui.click('Phantom');
    ui.draw({ view: { kind: 'working', step: 'checking', paying, about, cancellable: true } });
    ui.click('Cancel');
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    expect(ui.button('Phantom').disabled).toBe(true);
    await act(async () => {
      endFirst();
    });
    expect(ui.button('Phantom').disabled).toBe(true);
  });

  it('after Cancel, focus is on the wallet list it went back to', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer), { cancelDraws: offerView(offer) });
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    ui.draw({ view: { kind: 'working', step: 'checking', paying, about, cancellable: true } });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    ui.button('Cancel').focus();
    ui.click('Cancel');
    expect(ui.walletsOpen()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Choose a wallet');
  });

  it('gives no hint while the order is sent', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'ordering', paying, about });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(ui.has('.hint')).toBe(false);
  });

  it('counts down to a safe retry when the wallet did not sign, then checks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_750_000_000_000);
    const now = 1_750_000_000;
    const ui = mount(
      waitingView(about, paying, {
        signed: false,
        problem: { reason: 'wallet_failed' },
        retryIn: { seconds: 72, at: now },
      }),
    );
    expect(ui.container.querySelector('.countdown')?.textContent).toBe('1:12');
    expect(ui.text()).toContain('You can retry in about');
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(ui.container.querySelector('.countdown')?.textContent).toBe('1:00');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(ui.status().join(' ')).toContain('Checking whether the payment went through');
    expect(ui.has('.countdown')).toBe(false);
    expect(ui.buttons().some((each) => each.textContent?.includes('Start over') === true)).toBe(
      false,
    );
  });

  it('announces states only, never the ticking number', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_750_000_000_000);
    const ui = mount(
      waitingView(about, paying, { signed: false, retryIn: { seconds: 30, at: 1_750_000_000 } }),
    );
    for (const live of ui.status()) {
      expect(live).not.toMatch(/\d:\d\d/);
    }
    expect(ui.container.querySelector('.countdown')?.closest('[role="status"]')).toBeNull();
  });

  it('says a signed payment may still land before the retry opens', () => {
    const ui = mount(
      waitingView(about, paying, { retryIn: { seconds: 40, at: Math.floor(Date.now() / 1000) } }),
    );
    expect(ui.text()).toContain('If it does not land, a retry opens in about');
  });

  it('gives an honest wait when no estimate is known yet', () => {
    const ui = mount(waitingView(about, paying, { signed: false }));
    expect(ui.text()).toContain('A retry opens about two minutes after the attempt');
  });

  it('offers a retry and Start over once nothing can land, with no tick to confirm', () => {
    const ui = mount(
      waitingView(about, paying, {
        canRetry: true,
        signed: false,
        wallets: [{ name: 'Phantom' }],
        problem: { reason: 'wallet_failed' },
      }),
    );
    expect(ui.status().join(' ')).toContain('A retry is possible now');
    expect(ui.has('input[type="checkbox"]')).toBe(false);
    expect(ui.button('Phantom').disabled).toBe(false);
    ui.click('Phantom');
    expect(ui.calls.retry).toEqual(['Phantom']);
    ui.click('Start over');
    expect(ui.calls.startOver).toBe(1);
  });

  it('says to contact the store long after, by its own clock, with no new view', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_750_000_000_000);
    const ui = mount(waitingView(about, paying, { unsureAt: 1_750_000_600 }));
    expect(ui.text()).not.toContain('contact the store');
    act(() => {
      vi.advanceTimersByTime(601_000);
    });
    expect(ui.text()).toContain('If it does not resolve, contact the store');
  });

  it('only says to contact the store for a network this checkout cannot check', () => {
    const ui = mount(
      waitingView(about, paying, {
        unserved: true,
        retryIn: { seconds: 40, at: Math.floor(Date.now() / 1000) },
      }),
    );
    expect(ui.text()).toContain('This checkout cannot check this network');
    expect(ui.text()).not.toContain('retry');
    expect(ui.has('.countdown')).toBe(false);
  });

  it('promises Start over, never a retry, when it only follows the order', () => {
    const now = Math.floor(Date.now() / 1000);
    const ui = mount(
      waitingView(about, paying, { followOnly: true, retryIn: { seconds: 40, at: now } }),
    );
    expect(ui.text()).toContain('Start over opens in about');
    expect(ui.text()).not.toContain('retry');
    ui.draw({ view: waitingView(about, paying, { followOnly: true }) });
    expect(ui.text()).toContain('Start over opens about two minutes after the attempt');
    expect(ui.text()).not.toContain('retry');
    ui.draw({ view: waitingView(about, paying, { followOnly: true, canRetry: true }) });
    expect(ui.status().join(' ')).toContain('You can start over now');
    expect(ui.text()).not.toContain('Try again');
    expect(ui.button('Start over')).toBeDefined();
  });

  it('counts down to the end of a Tempo request, then checks, then says to contact the store', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_750_000_000_000);
    const now = 1_750_000_000;
    const ui = mount(
      waitingView(about, tempoPaying, {
        tempo: true,
        signed: false,
        requestEndsIn: { seconds: 40 * 60, at: now },
        unsureAt: now + 600,
      }),
    );
    expect(ui.text()).toContain('The checkout stops waiting for this request in about');
    expect(ui.container.querySelector('.countdown')?.textContent).toBe('40:00');
    // Minute 11: the request still runs, so it is not "taking long" yet.
    act(() => {
      vi.advanceTimersByTime(11 * 60_000);
    });
    expect(ui.text()).not.toContain('contact the store');
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(ui.status().join(' ')).toContain('Checking whether the request was approved');
    expect(ui.text()).toContain('Check your wallet activity, or contact the store');
  });

  it('never tells a buyer whose wallet sent the Tempo payment to approve or reject it', () => {
    const ui = mount(waitingView(about, tempoPaying, { tempo: true, signed: true }));
    expect(ui.text()).toContain('Your wallet sent the payment. The checkout is confirming it.');
    expect(ui.text()).not.toContain('Approve or reject');
    ui.draw({ view: waitingView(about, tempoPaying, { tempo: true, signed: false }) });
    expect(ui.text()).toContain('Approve or reject the request in your wallet');
  });

  it('never promises Start over on Tempo, even when it only follows the order', () => {
    const ui = mount(
      waitingView(about, tempoPaying, {
        tempo: true,
        signed: false,
        followOnly: true,
        requestEndsIn: { seconds: 600, at: Math.floor(Date.now() / 1000) },
      }),
    );
    expect(ui.text()).not.toContain('Start over');
  });

  it('shows a cancellation after payment as an alert', () => {
    const ui = mount({ kind: 'waiting_store', paying, about, cancelled: true, noAnswer: true });
    expect(ui.alerts().join(' ')).toContain('the store cancelled this order');
    // The payment did happen.
    expect(stageStates(ui)).toEqual(['done', 'done', 'done']);
    expect(ui.text()).toContain('The store has not answered for a while');
  });

  it('shows the wait for the store, every stage done: the payment is complete (S-b)', () => {
    const ui = mount({ kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false });
    expect(ui.text()).toContain('Paid. Waiting for the store to confirm');
    expect(ui.text()).toContain('Stores usually answer within minutes');
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Paid');
    expect(stageStates(ui)).toEqual(['done', 'done', 'done']);
    expect(ui.container.querySelector('[aria-current]')).toBeNull();
  });

  it('asks about an old prompt with its two buttons, the payment read-only above', () => {
    const ui = mount({ kind: 'old_prompt', orders: 1, until: 0, about, paying: tempoPaying });
    expect(ui.alerts().join(' ')).toContain('Your wallet may still show a payment request');
    expect(ui.alerts().join(' ')).toContain('will not complete that order on its own');
    expect(ui.container.querySelector('.pay-label')?.textContent).toBe('USDC · Tempo devnet');
    expect(ui.has('button.select')).toBe(false);
    expect(ui.button('I understand, continue')).toBeDefined();
    expect(ui.button('Back')).toBeDefined();
  });
});

describe('a sold-out product', () => {
  const SOLD_OUT = 'Sold out. This product is not available right now.';
  const PAID_LINE = 'An order already paid is still completed.';

  function soldOutShown(ui: Ui): void {
    expect(ui.text()).toContain(SOLD_OUT);
    expect(ui.text()).toContain(PAID_LINE);
    // Information, not a warning, and never the store's own words.
    expect(ui.alerts()).toEqual([]);
    expect(ui.text()).not.toContain('The listing is sold-out');
    expect(ui.text()).not.toContain('Not available');
    expect(ui.container.querySelector('img.mark')?.getAttribute('src')).toBe(SOLD_OUT_GLYPH);
  }

  it('the first screen: sold out, plainly', () => {
    const ui = mount(undefined);
    ui.draw({ screen: { kind: 'refused', reason: 'sold_out' } });
    soldOutShown(ui);
  });

  it('a refused view: the same, the store text dropped', () => {
    const ui = mount(undefined);
    ui.draw({
      view: {
        kind: 'refused',
        reason: 'sold_out',
        message: 'The listing is sold-out',
        store: { name: 'Demo Shop' },
      },
    });
    soldOutShown(ui);
  });

  it('any other refused view keeps the store refusal and its note', () => {
    const ui = mount(undefined);
    ui.draw({ view: { kind: 'refused', reason: 'offer_refused', message: 'gone' } });
    expect(ui.alerts().join(' ')).toContain('This product cannot be bought here.');
    expect(ui.text()).toContain('gone');
    expect(ui.text()).not.toContain(SOLD_OUT);
  });

  it('a followed order of a product stopped since: the problem says so', () => {
    const ui = mount(waitingView(about, paying, { problem: { reason: 'sold_out' } }));
    expect(ui.text()).toContain(
      'This product is sold out now. Your earlier order is still being checked.',
    );
  });
});

describe('a slow start', () => {
  it('says it is slow, never about an earlier order, and how to come back, inline', () => {
    const ui = mount(undefined);
    ui.draw({ screen: { kind: 'loading', slow: true } });
    expect(ui.text()).toContain('This is taking longer than usual.');
    expect(ui.text()).not.toContain('earlier order');
    expect(ui.text()).toContain('Keep this page open');
    expect(ui.text()).not.toContain('Not available');
  });

  it('says it can be closed, in a modal', () => {
    const ui = mount(undefined);
    ui.draw({ screen: { kind: 'loading', slow: true }, onClose: () => undefined });
    expect(ui.text()).toContain('You can close this and come back');
  });
});

describe('the done step', () => {
  it('says Payment complete, Buy again first as the primary button, nothing delivered (M8)', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Payment complete');
    const buttons = ui.buttons();
    expect(buttons[0]?.textContent).toBe('Buy again');
    expect(buttons[0]?.classList.contains('primary')).toBe(true);
    expect(ui.has('a.button')).toBe(false);
    expect(ui.buttons().some((each) => each.textContent === 'Copy')).toBe(false);
    expect(ui.text()).not.toContain('Delivered');
    ui.click('Buy again');
    expect(ui.calls.startOver).toBe(1);
  });

  it('says Payment complete for a sent transaction confirmed on chain (M28)', () => {
    const ui = mount({
      kind: 'delivered',
      receipt: receipt({ paid: undefined, sent: { tx: TX } }),
    });
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Payment complete');
  });

  it('says Order complete when no payment is known (a hand answer, a reverted payment) (M25)', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt({ paid: undefined }) });
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Order complete');
    expect(ui.text()).not.toContain('Payment complete');
  });

  it('switches the heading in the same render as the Transaction sent row', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt({ paid: undefined }) });
    expect(ui.text()).not.toContain('Transaction sent');
    ui.draw({
      view: { kind: 'delivered', receipt: receipt({ paid: undefined, sent: { tx: TX } }) },
    });
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Payment complete');
    expect(ui.text()).toContain('Transaction sent');
  });

  it('keeps naming the store', () => {
    const ui = mount({ kind: 'delivered', store: about.store });
    expect(ui.container.querySelector('.store-name')?.textContent).toBe('Demo Shop');
  });
});

const TX =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const PAID_AT = Date.UTC(2031, 4, 6, 12, 0, 0) / 1000;

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    store: 'Demo Shop',
    product: 'Agents 101',
    paying: { amount: '1500000', asset, network: 'mainnet', chain: 'solana' },
    orderId: 'order-1',
    paid: { tx: TX, at: PAID_AT, explorer: `https://explorer.solana.com/tx/${TX}` },
    answeredAt: PAID_AT + 60,
    ...overrides,
  };
}

describe('the receipt', () => {
  /** The full text "Copy receipt" copies (and the fallback shows and selects). */
  const receiptText = (
    _ui: Ui,
    shown: Receipt = receipt(),
    kind: 'delivered' | 'refunded' = 'delivered',
  ) => fullReceiptText(shown, kind);
  /** What the screen shows. */
  const shownText = (ui: Ui) => ui.container.querySelector('.receipt-text')?.textContent ?? '';
  const SHORT = `${TX.slice(0, 6)}…${TX.slice(-4)}`;

  it('says what was paid, when it was seen, the order and the full transaction', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    const text = receiptText(ui);
    expect(text).toContain('Store: Demo Shop');
    expect(text).toContain('Product: Agents 101');
    expect(text).toContain('Paid: 1.5 USDC · Solana');
    expect(text).toContain(`Payment confirmed on: ${new Date(PAID_AT * 1000).toLocaleString()}`);
    expect(text).toContain('2031');
    expect(text).toContain('Order: order-1');
    expect(text).toContain(`Transaction: ${TX}`);
  });

  it('shows the transaction shortened, as the link itself, with no separate link', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    const shown = shownText(ui);
    expect(shown).toContain(`Transaction: ${SHORT} ↗`);
    expect(shown).not.toContain(TX);
    const links = [...ui.container.querySelectorAll('.receipt a')];
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link?.textContent).toBe(`${SHORT} ↗`);
    expect(link?.getAttribute('href')).toBe(`https://explorer.solana.com/tx/${TX}`);
    expect(link?.getAttribute('title')).toBe(TX);
    expect(link?.getAttribute('aria-label')).toBe(`View transaction ${SHORT} on the explorer`);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(ui.text()).not.toContain('View transaction');
  });

  it('links no transaction without an https explorer page: the short id as text', () => {
    const ui = mount({
      kind: 'delivered',
      receipt: receipt({ paid: { tx: TX, at: PAID_AT, explorer: 'http://explorer.example/tx' } }),
    });
    expect(ui.container.querySelector('.receipt a')).toBeNull();
    expect(shownText(ui)).toContain(`Transaction: ${SHORT}`);
    expect(shownText(ui)).not.toContain('↗');
  });

  it('says what the order number is for, on screen only', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    const hint = ui.container.querySelector('.receipt .receipt-hint');
    expect(hint?.textContent).toBe('Give this number to the store if you need help.');
    expect(receiptText(ui)).not.toContain('Give this number');
  });

  it('claims no payment it did not see: the order total only, and no link', () => {
    const ui = mount({
      kind: 'refunded',
      receipt: receipt({ paid: undefined }),
    });
    const text = receiptText(ui, receipt({ paid: undefined }), 'refunded');
    expect(text).not.toContain('Paid');
    expect(text).not.toContain('Transaction');
    expect(text).toContain('Total: 1.5 USDC · Solana');
    expect(text).not.toContain('not seen');
    expect(text).toContain(`Refunded on: ${new Date((PAID_AT + 60) * 1000).toLocaleString()}`);
    expect(text).toContain('Refunded by the store');
    expect(shownText(ui)).not.toContain('Paid');
    expect(shownText(ui)).toContain('Total: 1.5 USDC · Solana');
    expect(ui.container.querySelector('.receipt a')).toBeNull();
  });

  it('copies the full receipt, under its own name', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    await act(async () => ui.button('Copy receipt').click());
    expect(writeText).toHaveBeenCalledWith(receiptText(ui));
    expect(receiptText(ui)).toContain(`Transaction: ${TX}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(
      ui.container.querySelector('.receipt .visually-hidden[role="status"]')?.textContent,
    ).toBe('Receipt copied.');
  });

  for (const [name, userAgent, touchPoints] of [
    ['a desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0],
    ['a phone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5],
  ] as const) {
    it(`on ${name}, a refused clipboard shows the full receipt and selects it`, async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
      vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(touchPoints);
      const writeText = vi.fn(async () => {
        throw new Error('denied');
      });
      vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
      const ui = mount({ kind: 'delivered', receipt: receipt() });
      expect(shownText(ui)).not.toContain(TX);
      await act(async () => ui.button('Copy receipt').click());
      const block = ui.container.querySelector('.receipt-text');
      expect(block?.textContent).toBe(receiptText(ui));
      expect(window.getSelection()?.toString()).toBe(receiptText(ui));
      expect(window.getSelection()?.anchorNode).toBe(block);
      expect(receiptText(ui)).toContain(`Transaction: ${TX}`);
    });
  }

  it('a successful copy never changes what the receipt shows', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    const before = shownText(ui);
    await act(async () => ui.button('Copy receipt').click());
    expect(shownText(ui)).toBe(before);
  });

  it('keeps a store-made title on one line, as text', () => {
    const title = 'X\nPaid: 999 USDC\u202e<b>bold</b>';
    const ui = mount({ kind: 'delivered', receipt: receipt({ product: title }) });
    const full = receiptText(ui, receipt({ product: title }));
    const lines = full.split('\n');
    expect(lines.filter((line) => line.startsWith('Product:'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Paid:'))).toHaveLength(1);
    expect(full).not.toContain('\u202e');
    expect(shownText(ui)).not.toContain('\u202e');
    expect(ui.container.querySelector('.receipt b')).toBeNull();
  });

  it('takes focus on its heading when it replaces the screen the buyer was on', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const ui = mount({ kind: 'working', step: 'checking', paying, about, cancellable: true });
    ui.button('Cancel').focus();
    expect(document.activeElement?.textContent).toBe('Cancel');
    ui.draw({ view: { kind: 'delivered', receipt: receipt() } });
    expect(document.activeElement?.textContent).toBe('Payment complete');
    expect(document.activeElement?.hasAttribute('data-heading')).toBe(true);
  });

  it('sits outside the refund’s live region, under the only section heading', () => {
    const ui = mount({ kind: 'refunded', receipt: receipt() });
    const block = ui.container.querySelector('.receipt');
    expect(block).not.toBeNull();
    expect(block?.closest('[role="status"]')).toBeNull();
    expect(ui.container.querySelectorAll('[data-heading]')).toHaveLength(1);
  });

  /** Whether `first` comes before `second` in the document. */
  const before = (first: Element | null | undefined, second: Element | null | undefined) =>
    first !== null &&
    first !== undefined &&
    second !== null &&
    second !== undefined &&
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('comes last when complete: the heading, Buy again, Done, then the receipt', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    ui.draw({ onClose: () => undefined });
    const heading = ui.container.querySelector('[data-heading]');
    const buyAgain = ui.button('Buy again');
    const done = ui.button('Done');
    const block = ui.container.querySelector('.receipt');
    expect(before(heading, buyAgain)).toBe(true);
    expect(before(buyAgain, done)).toBe(true);
    expect(done.classList.contains('secondary')).toBe(true);
    expect(before(done, block)).toBe(true);
  });

  it('comes last when refunded: the outcome, then Start a new order, then the receipt', () => {
    const ui = mount({ kind: 'refunded', receipt: receipt() });
    const status = ui.container.querySelector('[role="status"]');
    const start = ui.button('Start a new order');
    const block = ui.container.querySelector('.receipt');
    expect(before(status, start)).toBe(true);
    expect(before(start, block)).toBe(true);
  });
});

describe('the done step in a modal', () => {
  it('has Done, which asks the page to close; inline has none', () => {
    const closes: string[] = [];
    const ui = mount({ kind: 'delivered' });
    expect(ui.buttons().some((each) => each.textContent === 'Done')).toBe(false);
    ui.draw({ onClose: () => closes.push('close') });
    ui.click('Done');
    expect(closes).toEqual(['close']);
    expect(ui.calls.startOver).toBe(0);
  });
});

describe('the banner', () => {
  const banner: Banner = { orderId: 'x', state: 'completed' };
  const offer = cannedOffer();
  const views: { name: string; view: View | undefined }[] = [
    { name: 'loading', view: undefined },
    { name: 'the offer', view: offerView(offer) },
    { name: 'progress', view: { kind: 'working', step: 'checking', about } },
    { name: 'done', view: { kind: 'delivered' } },
    { name: 'refunded', view: { kind: 'refunded' } },
    { name: 'refused', view: { kind: 'refused', reason: 'offer_refused', message: 'no' } },
  ];
  for (const { name, view } of views) {
    it(`shows on ${name}`, () => {
      const ui = mount(view);
      ui.draw({ banner });
      expect(ui.container.querySelector('.banner')?.textContent).toBe(
        'A purchase from earlier is complete.',
      );
      // Nothing delivered is shown, even from an older node.
      expect(ui.container.querySelector('.banner a')).toBeNull();
    });
  }

  it('shows with the wallets open', () => {
    const ui = withWallets(offerView(offer));
    ui.draw({ banner });
    expect(ui.has('.banner')).toBe(true);
  });
});

describe('the trust chip', () => {
  const cases = [
    { level: 'A' as const, domain: 'shop.example', label: 'Verified: shop.example' },
    { level: 'B' as const, domain: 'elisym.shop', label: 'Named store' },
  ];
  for (const { level, domain, label } of cases) {
    it(`says ${label} at level ${level}, as a plain label`, () => {
      const ui = mount(offerView(cannedOffer({ level, domain })));
      const chip = ui.container.querySelector('.chip');
      expect(chip?.textContent).toBe(label);
      expect(chip?.tagName).toBe('SPAN');
      expect(ui.container.querySelector('.badges button')).toBeNull();
      expect(ui.has('.trust-detail')).toBe(false);
    });
  }

  it('shows none once the level is gone from the store, after an A offer showed one', () => {
    // A level A offer, then the session names the store without its level
    // (followed from a snapshot, or refused here): the chip goes.
    const ui = mount(offerView(cannedOffer({ level: 'A', domain: 'shop.example' })));
    expect(ui.has('.chip')).toBe(true);
    ui.draw({ view: waitingView({ ...about, store: { name: 'Demo Shop' } }, paying) });
    expect(ui.has('.chip')).toBe(false);
    ui.draw({
      view: {
        kind: 'refused',
        reason: 'offer_refused',
        message: 'gone',
        store: { name: 'Demo Shop' },
      },
    });
    expect(ui.has('.chip')).toBe(false);
  });

  it('shows no chip at level C, and no text about it', () => {
    const ui = mount(offerView(cannedOffer({ level: 'C' })));
    expect(ui.has('.chip')).toBe(false);
    expect(ui.text()).not.toContain('Unverified');
    expect(ui.text()).not.toContain('No website vouches');
  });
});

describe('store data', () => {
  it('is rendered as text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const offer = cannedOffer({ name: hostile, title: hostile, summary: hostile });
    const ui = mount(offerView(offer));
    expect(ui.container.querySelectorAll('img[src="x"]')).toHaveLength(0);
    expect(ui.container.querySelector('.store-name')?.textContent).toBe(hostile);
    expect(ui.container.querySelector('.product-title')?.textContent).toBe(hostile);
    ui.draw({
      view: { kind: 'delivered', receipt: receipt({ product: hostile, store: hostile }) },
    });
    expect(ui.container.querySelector('.receipt-text')?.textContent).toContain(hostile);
    expect(ui.container.querySelectorAll('img[src="x"]')).toHaveLength(0);
  });

  it('shows a refusal before any offer', () => {
    const ui = mount(undefined, { refused: true });
    expect(ui.alerts().join(' ')).toContain('This browser blocks storage');
  });
});

describe('focus', () => {
  /** The one section heading in the card, if any: never two. */
  const heading = (ui: Ui) => {
    const found = ui.container.querySelectorAll('[data-heading]');
    expect(found.length).toBeLessThanOrEqual(1);
    return found[0] ?? null;
  };

  it('never moves at load', () => {
    const ui = mount(offerView(cannedOffer()));
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });

  it('moves to the wallet heading on Choose wallet after a review', () => {
    const ui = mount(offerView(cannedOffer(), { problem: { reason: 'offer_changed' } }));
    ui.click('Choose wallet');
    expect(document.activeElement).toBe(heading(ui));
    expect(document.activeElement?.textContent).toBe('Choose a wallet');
  });

  it('moves to the first view a wallet click produces, and no further', async () => {
    let finish = () => undefined as void;
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.hold(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    ui.click('Phantom');
    (document.activeElement as HTMLElement | null)?.blur();
    ui.draw({ view: { kind: 'working', step: 'checking', about } });
    expect(document.activeElement).toBe(heading(ui));
    expect(document.activeElement?.textContent).toBe('Paying');
    (document.activeElement as HTMLElement | null)?.blur();
    ui.draw({ view: { kind: 'working', step: 'signing', about } });
    expect(ui.container.contains(document.activeElement)).toBe(false);
    await act(async () => finish());
  });

  it('falls back to the problem note when the action ends on the offer with a change', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    ui.draw({ view: { kind: 'working', step: 'checking', about } });
    ui.draw({ view: offerView(offer, { problem: { reason: 'offer_changed' } }) });
    expect(heading(ui)).toBeNull();
    expect(document.activeElement?.hasAttribute('data-problem-note')).toBe(true);
  });

  it('moves to the email field for a mistyped email', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer, { askEmail: true }));
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    ui.draw({ view: offerView(offer, { askEmail: true, problem: { reason: 'bad_email' } }) });
    expect(document.activeElement).toBe(ui.container.querySelector('input[type="email"]'));
  });

  it('lands on the wallet heading when Back leaves the old-prompt question', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.draw({ view: { kind: 'old_prompt', orders: 1, until: 0, about } });
    act(() => ui.button('Back').focus());
    ui.click('Back');
    expect(ui.calls.oldPromptBack).toBe(1);
    ui.draw({ view: offerView(offer) });
    expect(document.activeElement?.textContent).toBe('Choose a wallet');
  });

  it('is not taken by a view after an action that drew nothing', async () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => ui.button('Phantom').click());
    // The action settled with no view; the watch draws one later.
    ui.draw({ view: { kind: 'waiting_store', about, cancelled: false, noAnswer: false } });
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });

  it('is not taken when the buyer is elsewhere', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    (document.activeElement as HTMLElement | null)?.blur();
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    ui.draw({ view: offerView(offer, { problem: { reason: 'rpc_error' } }) });
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });
});

describe('the header', () => {
  const title = (ui: { container: HTMLElement }) =>
    ui.container.querySelector<HTMLElement>('#checkout-title');

  it('names the product first, then the store and its chips on a quieter line', () => {
    const ui = mount(offerView(cannedOffer({ level: 'A', domain: 'shop.example' })));
    expect(title(ui)?.tagName).toBe('H1');
    expect(title(ui)?.textContent).toBe('Agents 101');
    expect(title(ui)?.classList.contains('product-title')).toBe(true);
    const line = ui.container.querySelector('.store-line');
    expect(line?.querySelector('.store-name')?.textContent).toBe('Demo Shop');
    expect(line?.querySelector('.badge')?.textContent).toBe('Test network');
    expect(line?.querySelector('.chip')).not.toBeNull();
    expect(ui.container.querySelector('.card')?.getAttribute('aria-labelledby')).toBe(
      'checkout-title',
    );
    // Still exactly one section heading in the card: the header's is not one.
    expect(ui.container.querySelectorAll('[data-heading]').length).toBeLessThanOrEqual(1);
    expect(title(ui)?.hasAttribute('data-heading')).toBe(false);
  });

  it('shows the store name with no chip at level C', () => {
    const ui = mount(offerView(cannedOffer({ level: 'C' })));
    expect(ui.container.querySelector('.store-name')?.textContent).toBe('Demo Shop');
    expect(ui.has('.chip')).toBe(false);
  });

  it('keeps a long name whole for hover and screen readers, clamped by CSS', () => {
    const long = 'Deposit '.repeat(20).trim();
    const ui = mount(offerView(cannedOffer({ title: long })));
    expect(title(ui)?.textContent).toBe(long);
    expect(title(ui)?.getAttribute('title')).toBe(long);
  });

  it('renders at most 200 characters of an absurd name, cut between whole characters', () => {
    const family = '👨‍👩‍👧';
    const long = `${'a'.repeat(199)}${family}${'b'.repeat(400)}`;
    const ui = mount(offerView(cannedOffer({ title: long })));
    const shown = title(ui)?.textContent ?? '';
    expect(shown).toBe(`${'a'.repeat(199)}${family}…`);
    expect(title(ui)?.getAttribute('title')).toBe(long);
  });

  it('names the product on progress and on every ending', () => {
    const product = { title: 'Deposit 1 USD', price: { amount: '1', currency: 'USD' } };
    for (const view of [
      waitingView({ ...about, product }, paying),
      { kind: 'cancelled', store: about.store, product } as View,
      { kind: 'blocked', store: about.store, product } as View,
      { kind: 'delivered', store: about.store, product } as View,
      { kind: 'refunded', store: about.store, product } as View,
    ]) {
      const ui = mount(view);
      expect(title(ui)?.textContent).toBe('Deposit 1 USD');
      expect(ui.container.querySelector('.store-name')?.textContent).toBe('Demo Shop');
      render(null, ui.container);
      ui.container.remove();
    }
  });

  it('says "Checkout" before an offer is known', () => {
    const ui = mount(undefined);
    expect(title(ui)?.textContent).toBe('Checkout');
  });
});

describe('the receipt of a transaction this checkout only sent', () => {
  const sent = (): Receipt => ({
    store: 'Demo Shop',
    product: 'Agents 101',
    paying: { amount: '1500000', asset, network: 'mainnet', chain: 'solana' },
    orderId: 'order-1',
    sent: { tx: 'SIG', explorer: 'https://explorer.solana.com/tx/SIG' },
    answeredAt: Date.UTC(2031, 4, 6, 12, 0, 0) / 1000,
  });

  it('names it last, says Total (never Paid), as "Transaction sent" linked', () => {
    const ui = mount({ kind: 'delivered', receipt: sent() });
    const text = fullReceiptText(sent(), 'delivered');
    expect(text).toContain('Total: 1.5 USDC · Solana');
    expect(text).not.toContain('Paid');
    expect(text.split('\n').at(-1)).toBe('Transaction sent: SIG');
    expect(ui.container.querySelector('.receipt-text')?.textContent).toContain(
      'Transaction sent: SIG ↗',
    );
    const link = ui.container.querySelector('.receipt a');
    expect(link?.textContent).toBe('SIG ↗');
    expect(link?.getAttribute('href')).toBe('https://explorer.solana.com/tx/SIG');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('copy buttons', () => {
  it('fit every label in one cell, the inactive ones hidden from view and from the name', () => {
    const ui = mount({ kind: 'delivered', receipt: receipt() });
    const options = [...ui.container.querySelectorAll('.copy-button .label-option')];
    expect(options.map((option) => option.getAttribute('data-current'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(ui.container.querySelector('.visually-hidden[role="status"]')?.textContent).toBe('');
  });

  it('go back to their name after a while', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn(async () => undefined);
      vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
      const ui = mount({ kind: 'delivered', receipt: receipt() });
      await act(async () => ui.button('Copy receipt').click());
      expect(currentLabel(ui)).toBe('✓ Copied');
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(currentLabel(ui)).toBe('Copy receipt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announce a second copy again (cleared, then set on the next tick)', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn(async () => undefined);
      vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
      const ui = mount({ kind: 'delivered', receipt: receipt() });
      const region = ui.container.querySelector('.visually-hidden[role="status"]') as HTMLElement;
      const texts: string[] = [];
      const observer = new MutationObserver(() => texts.push(region.textContent ?? ''));
      observer.observe(region, { childList: true, characterData: true, subtree: true });
      for (let click = 0; click < 2; click += 1) {
        await act(async () => ui.button('Copy receipt').click());
        await act(async () => {
          vi.advanceTimersByTime(1);
        });
      }
      await act(async () => Promise.resolve());
      observer.disconnect();
      expect(texts.filter((text) => text === 'Receipt copied.').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
  for (const [name, userAgent, touchPoints, label, announcement] of [
    ['a phone', IPHONE_UA, 5, 'Text selected', 'Text selected: copy it from the menu.'],
    [
      'an iPad that says it is a Mac',
      MAC_UA,
      5,
      'Text selected',
      'Text selected: copy it from the menu.',
    ],
    ['a Mac', MAC_UA, 0, 'Press ⌘C', 'Selected: Press ⌘C to copy it.'],
  ] as const) {
    it(`point the buyer at how to copy the selection on ${name}`, async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
        vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(touchPoints);
        const writeText = vi.fn(async () => {
          throw new Error('denied');
        });
        vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
        const ui = mount({ kind: 'delivered', receipt: receipt() });
        await act(async () => ui.button('Copy receipt').click());
        await act(async () => {
          vi.advanceTimersByTime(1);
        });
        expect(currentLabel(ui)).toBe(label);
        expect(ui.container.querySelector('.visually-hidden[role="status"]')?.textContent).toBe(
          announcement,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe('sections that appear', () => {
  it('fade in only outside a step that already does, with no fill that could hide them', () => {
    const ui = mount(offerView(cannedOffer(), { problem: { reason: 'offer_changed' } }));
    const note = ui.container.querySelector('[data-problem-note]');
    expect(note?.classList.contains('reveal')).toBe(true);
    expect(note?.closest('.step')).toBeNull();
  });
});

describe('the stepper (S-a, S-b)', () => {
  const progressViews: [string, View][] = [
    ['checking', { kind: 'working', step: 'checking', paying, about }],
    ['ordering', { kind: 'working', step: 'ordering', paying, about }],
    ['signing', { kind: 'working', step: 'signing', paying, about }],
    ['a retry', waitingView(about, paying, { canRetry: true })],
    ['confirming', waitingView(about, paying)],
    ['paid', { kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false }],
  ];

  it('has three stages on every progress view: no "Complete", no "Payment confirmed"', () => {
    for (const [, view] of progressViews) {
      const ui = mount(view);
      const names = [...ui.container.querySelectorAll('.stepper li')].map(stageName);
      expect(names).toEqual([...STEPPER_STAGES]);
      expect(names).toEqual(['Order sent', 'Confirm in wallet', 'Payment complete']);
      expect(ui.text()).not.toContain('Payment confirmed');
      document.body.replaceChildren();
    }
  });

  it('marks the current stage, and says each state in text, not color only', () => {
    const expected: Record<string, (string | null)[]> = {
      checking: ['active', 'todo', 'todo'],
      ordering: ['active', 'todo', 'todo'],
      signing: ['done', 'active', 'todo'],
      'a retry': ['done', 'active', 'todo'],
      confirming: ['done', 'done', 'active'],
      paid: ['done', 'done', 'done'],
    };
    for (const [name, view] of progressViews) {
      const ui = mount(view);
      expect(stageStates(ui)).toEqual(expected[name]);
      const stages = [...ui.container.querySelectorAll('.stepper li')];
      for (const stage of stages) {
        const state = stage.getAttribute('data-state');
        const hidden = stage.querySelector('.visually-hidden')?.textContent;
        const suffixes: Record<string, string> = { done: ', done', active: ', current' };
        expect(hidden).toBe(state === null ? undefined : suffixes[state]);
        expect(stage.getAttribute('aria-current')).toBe(state === 'active' ? 'step' : null);
      }
      document.body.replaceChildren();
    }
    const confirming = mount(waitingView(about, paying));
    expect(stageName(confirming.container.querySelector('[aria-current="step"]'))).toBe(
      'Payment complete',
    );
  });
});

describe('the last stage fills before the done screen (D9)', () => {
  const WAIT = 2500;
  const FILL = 600;
  const confirming = (overrides: Parameters<typeof waitingView>[2] = {}) =>
    waitingView(about, paying, overrides);
  const delivered = (shown: Receipt = receipt()): View => ({
    kind: 'delivered',
    store: about.store,
    product: about.product,
    receipt: shown,
  });
  const unpaid = () => receipt({ paid: undefined });
  const progress = (ui: Ui) => ui.container.querySelector('[data-step="progress"]');
  const done = (ui: Ui) => ui.container.querySelector('[data-step="done"]');
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  /** The card as markup, with what a hold may change (the stepper's state, inert) taken out. */
  const normalized = (ui: Ui) => {
    const card = ui.container.querySelector('.card')?.cloneNode(true);
    if (!(card instanceof Element)) {
      throw new Error('no card');
    }
    for (const stage of card.querySelectorAll('.stepper li')) {
      stage.removeAttribute('data-state');
      stage.removeAttribute('aria-current');
      stage.querySelector('.visually-hidden')?.remove();
    }
    const step = card.querySelector('[data-step="progress"]');
    step?.removeAttribute('inert');
    step?.removeAttribute('aria-busy');
    return card.outerHTML;
  };
  const finishing = (options: MountOptions = {}, from: View = confirming()) =>
    mount(from, { finishWaitMs: WAIT, finishFillMs: FILL, ...options });

  it('fills the third stage, then shows "Payment complete" (S-c, S3)', () => {
    vi.useFakeTimers();
    const ui = finishing({}, confirming({ problem: { reason: 'wallet_failed' } }));
    expect(ui.text()).toContain('The wallet did not sign.');
    const before = normalized(ui);
    ui.draw({ view: delivered() });
    expect(progress(ui)).not.toBeNull();
    expect(stageStates(ui)).toEqual(['done', 'done', 'done']);
    expect(ui.container.querySelector('[aria-current]')).toBeNull();
    expect(progress(ui)?.hasAttribute('inert')).toBe(true);
    expect(ui.text()).not.toContain('Buy again');
    // Held exactly as it was, its problem note too (S19).
    expect(normalized(ui)).toBe(before);
    advance(FILL / 2);
    // The same completed order drawn again never restarts the fill (S16).
    ui.draw({ view: delivered() });
    expect(normalized(ui)).toBe(before);
    advance(FILL / 2 - 1);
    expect(progress(ui)).not.toBeNull();
    expect(done(ui)).toBeNull();
    advance(1);
    expect(progress(ui)).toBeNull();
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Payment complete');
    expect(ui.text()).toContain('Buy again');
  });

  it('waits for the payment to show before filling, then fills (S-d, S4)', () => {
    vi.useFakeTimers();
    const ui = finishing();
    const before = normalized(ui);
    ui.draw({ view: delivered(unpaid()) });
    expect(progress(ui)).not.toBeNull();
    // Still confirming: the circle named "Payment complete" is not filled for "Order complete".
    expect(stageStates(ui)).toEqual(['done', 'done', 'active']);
    expect(normalized(ui)).toBe(before);
    advance(1000);
    expect(stageStates(ui)).toEqual(['done', 'done', 'active']);
    ui.draw({ view: delivered(receipt({ paid: undefined, sent: { tx: TX } })) });
    expect(stageStates(ui)).toEqual(['done', 'done', 'done']);
    expect(normalized(ui)).toBe(before);
    advance(FILL - 1);
    expect(done(ui)).toBeNull();
    advance(1);
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Payment complete');
  });

  it('shows "Order complete" with no fill once the wait runs out, armed once (S-d, S5, S16)', () => {
    vi.useFakeTimers();
    const ui = finishing();
    let allDone = false;
    const observer = new MutationObserver(() => {
      const states = stageStates(ui);
      if (states.length > 0 && states.every((state) => state === 'done')) {
        allDone = true;
      }
    });
    observer.observe(ui.container, { attributes: true, subtree: true, childList: true });
    ui.draw({ view: delivered(unpaid()) });
    advance(WAIT - 100);
    // The same "Order complete" drawn again does not extend the wait.
    ui.draw({ view: delivered(unpaid()) });
    advance(99);
    expect(progress(ui)).not.toBeNull();
    advance(1);
    observer.disconnect();
    expect(progress(ui)).toBeNull();
    expect(ui.container.querySelector('[data-heading]')?.textContent).toBe('Order complete');
    expect(allDone).toBe(false);
  });

  it('swaps at once under reduced motion, with no timer left (S-e, S6)', () => {
    vi.useFakeTimers();
    const ui = finishing({ reducedMotion: () => true });
    ui.draw({ view: delivered() });
    expect(progress(ui)).toBeNull();
    expect(done(ui)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const waiting = finishing({ reducedMotion: () => true });
    waiting.draw({ view: delivered(unpaid()) });
    expect(done(waiting)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never holds without a confirming step seen in this session (S-f, S7, S15, S20)', () => {
    vi.useFakeTimers();
    const atOnce: [string, View | undefined][] = [
      ['a load', undefined],
      ['the wallet still open', { kind: 'working', step: 'signing', paying, about }],
      [
        'the store waited on',
        { kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false },
      ],
      ['a retry offered', confirming({ canRetry: true })],
    ];
    for (const [name, from] of atOnce) {
      const ui = from === undefined ? finishing({}, delivered()) : finishing({}, from);
      if (from !== undefined) {
        ui.draw({ view: delivered() });
      }
      expect({ name, done: done(ui) !== null }).toEqual({ name, done: true });
      expect({ name, timers: vi.getTimerCount() }).toEqual({ name, timers: 0 });
      document.body.replaceChildren();
    }
    const refunded = finishing({}, { kind: 'working', step: 'signing', paying, about });
    refunded.draw({ view: { kind: 'refunded', receipt: receipt() } });
    expect(refunded.text()).toContain('Refunded');
    const blocked = finishing();
    blocked.draw({ view: { kind: 'blocked', store: about.store } });
    expect(blocked.text()).toContain('Payment blocked');
    expect(progress(blocked)).toBeNull();
    // A network this checkout cannot check never says "Payment complete": no wait.
    const unserved = finishing({}, confirming({ unserved: true }));
    unserved.draw({ view: delivered(unpaid()) });
    expect(unserved.container.querySelector('[data-heading]')?.textContent).toBe('Order complete');
  });

  it('never holds a completion that arrives under "Your purchases": Back shows it at once (S-f)', () => {
    vi.useFakeTimers();
    const ui = finishing({ purchases: cannedSource([]) });
    ui.click('Your purchases');
    ui.draw({ view: delivered() });
    act(() =>
      ui.container.querySelector<HTMLButtonElement>('[aria-label="Back to checkout"]')?.click(),
    );
    expect(done(ui)).not.toBeNull();
    expect(progress(ui)).toBeNull();
  });

  it('is cancelled by another view, a reset or an unmount (S-g, S8)', () => {
    vi.useFakeTimers();
    const ui = finishing();
    ui.draw({ view: delivered() });
    expect(progress(ui)).not.toBeNull();
    ui.draw({ view: { kind: 'refunded', receipt: receipt() } });
    expect(ui.text()).toContain('Refunded');
    // Its timer is gone too: nothing fires later (a redraw, a focus move).
    expect(vi.getTimerCount()).toBe(0);
    advance(FILL * 10);
    expect(done(ui)).toBeNull();
    expect(ui.text()).toContain('Refunded');

    const reset = finishing();
    reset.draw({ view: delivered(unpaid()) });
    expect(progress(reset)).not.toBeNull();
    reset.draw({ resetCount: 1 });
    expect(progress(reset)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    document.body.replaceChildren();
    const gone = finishing();
    gone.draw({ view: delivered() });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => render(null, gone.container));
    expect(vi.getTimerCount()).toBe(0);
    advance(FILL * 10);
    expect(gone.container.innerHTML).toBe('');
  });

  it('is cancelled by opening "Your purchases": Back shows the done screen, no timer left (S-g)', () => {
    vi.useFakeTimers();
    const ui = finishing({ purchases: cannedSource([]) });
    ui.draw({ view: delivered() });
    expect(progress(ui)).not.toBeNull();
    ui.click('Your purchases');
    act(() =>
      ui.container.querySelector<HTMLButtonElement>('[aria-label="Back to checkout"]')?.click(),
    );
    expect(done(ui)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the step inert and busy in both phases, until the swap (S-h, S9)', () => {
    vi.useFakeTimers();
    const ui = finishing();
    expect(progress(ui)?.hasAttribute('inert')).toBe(false);
    expect(progress(ui)?.hasAttribute('aria-busy')).toBe(false);
    ui.draw({ view: delivered(unpaid()) });
    expect(progress(ui)?.hasAttribute('inert')).toBe(true);
    expect(progress(ui)?.getAttribute('aria-busy')).toBe('true');
    ui.draw({ view: delivered() });
    expect(progress(ui)?.hasAttribute('inert')).toBe(true);
    expect(progress(ui)?.getAttribute('aria-busy')).toBe('true');
    advance(FILL);
    expect(progress(ui)).toBeNull();
    expect(ui.container.querySelector('[inert], [aria-busy]')).toBeNull();
  });

  describe('focus (S-i)', () => {
    const heading = (ui: Ui) => ui.container.querySelector<HTMLElement>('[data-heading]');

    it('moves to the done heading at the swap when the inert step lost it (S10, S12)', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      expect(document.activeElement?.textContent).toBe('Confirming payment');
      ui.draw({ view: delivered() });
      // As Chrome and Firefox do to an element that becomes inert.
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(document.activeElement).toBe(document.body);
      advance(FILL);
      expect(document.activeElement?.textContent).toBe('Payment complete');
      expect(document.activeElement?.hasAttribute('data-heading')).toBe(true);
    });

    it('moves to the done heading even when focus stayed in the held step', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      advance(FILL);
      expect(document.activeElement?.textContent).toBe('Payment complete');
    });

    it('stays where the buyer moved it during the hold', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing({ purchases: cannedSource([]) });
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      const link = ui.container.querySelector<HTMLElement>('[data-purchases-button]');
      act(() => link?.focus());
      advance(FILL);
      expect(done(ui)).not.toBeNull();
      expect(document.activeElement).toBe(link);
    });

    it('moves to the next view’s heading when a hold is cancelled with focus lost (S21)', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      ui.draw({ view: { kind: 'refunded', receipt: receipt() } });
      expect(document.activeElement?.textContent).toBe('Refunded');
    });

    it('is not taken at the swap when focus was outside the content as the hold began', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(document.activeElement).toBe(document.body);
      ui.draw({ view: delivered() });
      expect(progress(ui)).not.toBeNull();
      advance(FILL);
      expect(done(ui)).not.toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it('is not taken when a hold is cancelled and focus was outside the content as it began', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(document.activeElement).toBe(document.body);
      ui.draw({ view: delivered() });
      expect(progress(ui)).not.toBeNull();
      ui.draw({ view: { kind: 'refunded', receipt: receipt() } });
      expect(ui.text()).toContain('Refunded');
      expect(document.activeElement).toBe(document.body);
    });

    it('moves to the done heading at the swap when focus went outside the card', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      const outside = document.createElement('button');
      document.body.append(outside);
      act(() => outside.focus());
      expect(document.activeElement).toBe(outside);
      advance(FILL);
      expect(document.activeElement?.textContent).toBe('Payment complete');
      outside.remove();
    });

    it('stays outside the card when a hold is cancelled there', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      const outside = document.createElement('button');
      document.body.append(outside);
      act(() => outside.focus());
      ui.draw({ view: { kind: 'refunded', receipt: receipt() } });
      expect(ui.text()).toContain('Refunded');
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });

    it('is not taken at the swap when focus was in the header as the hold began', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const ui = finishing();
      const title = ui.container.querySelector<HTMLElement>('.header #checkout-title');
      act(() => title?.focus());
      expect(document.activeElement).toBe(title);
      ui.draw({ view: delivered() });
      advance(FILL);
      expect(done(ui)).not.toBeNull();
      expect(document.activeElement).toBe(title);
    });

    it('is not taken when the frame does not have focus', () => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      const ui = finishing();
      act(() => heading(ui)?.focus());
      ui.draw({ view: delivered() });
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      advance(FILL);
      expect(done(ui)).not.toBeNull();
      expect(ui.container.contains(document.activeElement)).toBe(false);
    });
  });

  it('fills by a color transition no longer than the hold, never replayed on a mount (S-j, S11)', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/styles.css'), 'utf8');
    const fill = /--step-fill:\s*(\d+)ms;/.exec(css);
    expect(fill).not.toBeNull();
    expect(Number(fill?.[1])).toBeLessThanOrEqual(FINISH_FILL_MS);
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.[\]'=:()]/g, (character) => `\\${character}`);
      return new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? '';
    };
    expect(rule('.stepper li::before')).toMatch(/transition:[^;]*var\(--step-fill\)/);
    expect(rule(".stepper li[data-state='done']::before")).not.toMatch(/animation/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*transition: none !important;/,
    );
    expect(FINISH_FILL_MS).toBe(600);
    expect(FINISH_WAIT_MS).toBe(2500);
  });
});
