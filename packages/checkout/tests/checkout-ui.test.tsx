// @vitest-environment happy-dom
import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReadyOffer,
  aboutOf,
  cannedOffer,
  offerView,
  waitingView,
} from '../scripts/fixtures/canned';
import { type Actions, Checkout } from '../src/app/Checkout';
import type { Screen } from '../src/app/controller';
import type { Banner, Paying, Problem, Receipt, View } from '../src/app/session';
import { PROBLEM_PLACE } from '../src/app/ui/panel';

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
}

/** A `Checkout` in the page, with actions that record what they were asked. */
function mount(
  view?: View,
  options: { refused?: boolean; hintAfterMs?: number; cancelDraws?: View } = {},
) {
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

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withWallets(view: View): Ui {
  const ui = mount(view);
  ui.click('Choose wallet');
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

  it('opens the wallets below the offer, hiding nothing above them', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] })));
    expect(ui.walletsOpen()).toBe(false);
    ui.click('Choose wallet');
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

  it('shows a wallet problem above the button while the wallets are closed', () => {
    const offer = cannedOffer({ payouts: ['tempo-devnet'] });
    const ui = mount(waitingView(about, tempoPaying, { tempo: true, signed: false }));
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

  it('starts closed on the offer after a payment ended back on it', () => {
    const offer = cannedOffer();
    const ui = withWallets(offerView(offer));
    ui.draw({ view: waitingView(about, paying, { canRetry: true }) });
    ui.draw({ view: offerView(offer) });
    expect(ui.walletsOpen()).toBe(false);
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
    expect(ui.container.querySelector('.pay-label')?.textContent).toBe('USDC · Solana mainnet');
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

  it('keeps what was typed while the wallets open below', () => {
    const ui = mount(offerView(cannedOffer(), { askEmail: true }));
    act(() => {
      input(ui).value = 'buyer@example.com';
      input(ui).dispatchEvent(new Event('input', { bubbles: true }));
    });
    ui.click('Choose wallet');
    expect(input(ui).value).toBe('buyer@example.com');
    expect(ui.calls.email.at(-1)).toBe('buyer@example.com');
  });

  it('is reseeded from the session on every offer', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true, email: 'a@example.com' }));
    ui.click('Choose wallet');
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

  it('is not asked while an open order on the same terms continues', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true, continuing: 'ordered' }));
    expect(input(ui)).toBeNull();
    expect(ui.text()).toContain('Your earlier order is still open; an email, if given, was sent');
    ui.draw({ view: offerView(offer, { askEmail: true, continuing: 'created' }) });
    expect(input(ui)).toBeNull();
    expect(ui.text()).toContain('Your earlier order is being sent; an email, if given, goes');
    ui.draw({ view: offerView(offer, { askEmail: true, continuing: false }) });
    expect(input(ui)).not.toBeNull();
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

describe('progress', () => {
  it('names the product and the exact payment, read-only, in place of the choice', () => {
    const ui = mount({ kind: 'working', step: 'signing', paying, about });
    expect(ui.text()).toContain('Confirm the payment in your wallet');
    expect(ui.container.querySelector('.product-title')?.textContent).toBe('Agents 101');
    expect(ui.container.querySelector('.paying')?.textContent).toBe(
      'Paying 55 USDC · Solana devnet',
    );
    expect(ui.container.querySelector('[aria-current="step"]')?.textContent).toBe(
      'Confirm in wallet',
    );
  });

  it('names the store and the product of a payment resumed after a reload', () => {
    const ui = mount(waitingView(aboutOf(cannedOffer({ name: 'Resumed Shop' })), paying));
    expect(ui.container.querySelector('#store-name')?.textContent).toBe('Resumed Shop');
    expect(ui.container.querySelector('.product-title')?.textContent).toBe('Agents 101');
  });

  it('shows no trust chip for a store named from an order’s old snapshot', () => {
    const ui = mount(waitingView({ ...about, store: { name: 'Demo Shop' } }, paying));
    expect(ui.container.querySelector('#store-name')?.textContent).toBe('Demo Shop');
    expect(ui.has('.chip')).toBe(false);
  });

  for (const step of ['checking', 'signing'] as const) {
    it(`says what to do when the wallet has not answered for a while (${step})`, () => {
      vi.useFakeTimers();
      const ui = mount({ kind: 'working', step, paying, about });
      expect(ui.has('.hint')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expect(ui.has('.hint')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const hint = ui.container.querySelector('.hint')?.textContent ?? '';
      expect(hint).toBe(
        step === 'checking'
          ? 'This is taking long. Reload the page to try again; no new payment request has been sent to your wallet.'
          : 'Your wallet has not answered. If you closed its window, reload the page: the order picks up where it is, and a retry opens once it is safe.',
      );
    });
  }

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
    ui.click('Choose wallet');
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
    ui.click('Choose wallet');
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    ui.draw({ view: { kind: 'working', step: 'checking', paying, about, cancellable: true } });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    ui.button('Cancel').focus();
    ui.click('Cancel');
    expect(ui.walletsOpen()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Choose a wallet');
  });

  it('words the hint for Tempo, and gives none while the order is sent', () => {
    vi.useFakeTimers();
    const ui = mount({ kind: 'working', step: 'signing', paying: tempoPaying, about });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(ui.container.querySelector('.hint')?.textContent).toContain(
      'keeps checking the request',
    );
    ui.draw({ view: { kind: 'working', step: 'ordering', paying, about } });
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
    expect(ui.text()).toContain('The store has not answered for a while');
  });

  it('shows the wait for the store', () => {
    const ui = mount({ kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false });
    expect(ui.text()).toContain('Paid. Waiting for the store to deliver');
    expect(ui.text()).toContain('Stores usually answer within minutes');
    expect(ui.container.querySelector('[aria-current="step"]')?.textContent).toBe('Delivered');
  });

  it('asks about an old prompt with its two buttons, the payment read-only above', () => {
    const ui = mount({ kind: 'old_prompt', orders: 1, until: 0, about, paying: tempoPaying });
    expect(ui.alerts().join(' ')).toContain('may still be open in your wallet');
    expect(ui.container.querySelector('.pay-label')?.textContent).toBe('USDC · Tempo devnet');
    expect(ui.has('button.select')).toBe(false);
    expect(ui.button('I understand, continue')).toBeDefined();
    expect(ui.button('Back')).toBeDefined();
  });
});

describe('a slow start', () => {
  it('says the checkout is still checking, and how to come back, inline', () => {
    const ui = mount(undefined);
    ui.draw({ screen: { kind: 'loading', slow: true } });
    expect(ui.text()).toContain('still checking your earlier order');
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
  it('opens an https: delivery from a button, naming its host', () => {
    const ui = mount({
      kind: 'delivered',
      text: 'https://shop.example/course',
      link: 'https://shop.example/course',
    });
    const open = ui.container.querySelector('a.button') as HTMLAnchorElement;
    expect(open.textContent).toBe('Open');
    expect(open.getAttribute('href')).toBe('https://shop.example/course');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(ui.text()).toContain('shop.example');
    expect(ui.text()).not.toContain('https://shop.example/course');
    expect(ui.text()).not.toContain('View transaction');
    ui.click('Buy again');
    expect(ui.calls.startOver).toBe(1);
  });

  it('copies a text delivery', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', text: 'KEY-1234' });
    expect(ui.has('a.button')).toBe(false);
    await act(async () => ui.button('Copy').click());
    expect(writeText).toHaveBeenCalledWith('KEY-1234');
    expect(ui.text()).toContain('Copied.');
  });

  it('selects the text when the clipboard is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', text: 'KEY-1234' });
    await act(async () => ui.button('Copy').click());
    expect(window.getSelection()?.toString()).toBe('KEY-1234');
    expect(ui.text()).toContain('Selected');
  });

  it('keeps naming the store', () => {
    const ui = mount({ kind: 'delivered', text: 'KEY-1234', store: about.store });
    expect(ui.container.querySelector('#store-name')?.textContent).toBe('Demo Shop');
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
  const receiptText = (ui: Ui) => ui.container.querySelector('.receipt-text')?.textContent ?? '';

  it('says what was paid, when it was seen, the order and the full transaction', () => {
    const ui = mount({ kind: 'delivered', text: 'KEY-1234', receipt: receipt() });
    const text = receiptText(ui);
    expect(text).toContain('Store: Demo Shop');
    expect(text).toContain('Product: Agents 101');
    expect(text).toContain('Paid: 1.5 USDC · Solana mainnet');
    expect(text).toContain(`Payment confirmed on: ${new Date(PAID_AT * 1000).toLocaleString()}`);
    expect(text).toContain('2031');
    expect(text).toContain('Order: order-1');
    expect(text).toContain(`Transaction: ${TX}`);
    const link = [...ui.container.querySelectorAll('.receipt a')].find(
      (each) => each.textContent === 'View transaction',
    );
    expect(link?.getAttribute('href')).toBe(`https://explorer.solana.com/tx/${TX}`);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('claims no payment it did not see: the order total only, and no link', () => {
    const ui = mount({
      kind: 'refunded',
      receipt: receipt({ paid: undefined }),
    });
    const text = receiptText(ui);
    expect(text).not.toContain('Paid');
    expect(text).not.toContain('Transaction');
    expect(text).toContain('Order total: 1.5 USDC · Solana mainnet');
    expect(text).toContain('Payment: not seen by this checkout');
    expect(text).toContain(`Refunded on: ${new Date((PAID_AT + 60) * 1000).toLocaleString()}`);
    expect(text).toContain('Refunded by the store');
    expect(ui.container.querySelector('.receipt a')).toBeNull();
  });

  it('copies exactly what it shows, under its own name', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', text: 'KEY-1234', receipt: receipt() });
    await act(async () => ui.button('Copy receipt').click());
    expect(writeText).toHaveBeenCalledWith(receiptText(ui));
    expect(ui.text()).toContain('Receipt copied.');
  });

  it('selects exactly what it shows when the clipboard is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    const ui = mount({ kind: 'delivered', text: 'KEY-1234', receipt: receipt() });
    await act(async () => ui.button('Copy receipt').click());
    expect(window.getSelection()?.toString()).toBe(receiptText(ui));
  });

  it('keeps a store-made title on one line, as text', () => {
    const title = 'X\nPaid: 999 USDC\u202e<b>bold</b>';
    const ui = mount({ kind: 'delivered', text: 'KEY', receipt: receipt({ product: title }) });
    const lines = receiptText(ui).split('\n');
    expect(lines.filter((line) => line.startsWith('Product:'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Paid:'))).toHaveLength(1);
    expect(receiptText(ui)).not.toContain('\u202e');
    expect(ui.container.querySelector('.receipt b')).toBeNull();
  });

  it('takes focus on its heading when it replaces the screen the buyer was on', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const ui = mount({ kind: 'working', step: 'checking', paying, about, cancellable: true });
    ui.button('Cancel').focus();
    expect(document.activeElement?.textContent).toBe('Cancel');
    ui.draw({ view: { kind: 'delivered', text: 'KEY-1234', receipt: receipt() } });
    expect(document.activeElement?.textContent).toBe('Delivered');
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

  it('comes last when delivered: the delivery, then Buy again, then the receipt', () => {
    const ui = mount({
      kind: 'delivered',
      text: 'https://shop.example/course',
      link: 'https://shop.example/course',
      receipt: receipt(),
    });
    const heading = ui.container.querySelector('[data-heading]');
    const open = ui.container.querySelector('a.button');
    const buyAgain = ui.button('Buy again');
    const block = ui.container.querySelector('.receipt');
    expect(before(heading, open)).toBe(true);
    expect(before(open, buyAgain)).toBe(true);
    expect(before(buyAgain, block)).toBe(true);
    const text = mount({ kind: 'delivered', text: 'KEY-1234', receipt: receipt() });
    expect(before(text.button('Copy'), text.button('Buy again'))).toBe(true);
    expect(before(text.button('Buy again'), text.button('Copy receipt'))).toBe(true);
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
    const ui = mount({ kind: 'delivered', text: 'KEY-1234' });
    expect(ui.buttons().some((each) => each.textContent === 'Done')).toBe(false);
    ui.draw({ onClose: () => closes.push('close') });
    ui.click('Done');
    expect(closes).toEqual(['close']);
    expect(ui.calls.startOver).toBe(0);
  });
});

describe('the banner', () => {
  const banner: Banner = {
    orderId: 'x',
    state: 'completed',
    text: 'https://shop.example/a',
    link: 'https://shop.example/a',
  };
  const offer = cannedOffer();
  const views: { name: string; view: View | undefined }[] = [
    { name: 'loading', view: undefined },
    { name: 'the offer', view: offerView(offer) },
    { name: 'progress', view: { kind: 'working', step: 'checking', about } },
    { name: 'done', view: { kind: 'delivered', text: 'x' } },
    { name: 'refunded', view: { kind: 'refunded' } },
    { name: 'refused', view: { kind: 'refused', message: 'no' } },
  ];
  for (const { name, view } of views) {
    it(`shows on ${name}`, () => {
      const ui = mount(view);
      ui.draw({ banner });
      expect(ui.container.querySelector('.banner a')?.getAttribute('href')).toBe(
        'https://shop.example/a',
      );
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
    ui.draw({ view: { kind: 'refused', message: 'gone', store: { name: 'Demo Shop' } } });
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
    expect(ui.container.querySelector('#store-name')?.textContent).toBe(hostile);
    expect(ui.container.querySelector('.product-title')?.textContent).toBe(hostile);
    ui.draw({ view: { kind: 'delivered', text: hostile } });
    expect(ui.container.querySelector('.delivery')?.textContent).toBe(hostile);
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
    expect(heading(ui)).toBeNull();
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });

  it('moves to the wallet heading on Choose wallet', () => {
    const ui = mount(offerView(cannedOffer()));
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
