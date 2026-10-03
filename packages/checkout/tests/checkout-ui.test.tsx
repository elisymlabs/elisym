// @vitest-environment happy-dom
import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReadyOffer, cannedOffer, offerView } from '../scripts/fixtures/canned';
import { type Actions, Checkout } from '../src/app/Checkout';
import type { Banner, Problem, View } from '../src/app/session';
import { PROBLEM_STEP } from '../src/app/ui/steps';

interface Calls {
  pay: string[];
  retry: string[];
  startOver: number;
  choose: number[];
  confirm: boolean[];
  email: string[];
}

interface DrawProps {
  view?: View;
  banner?: Banner;
}

/** A `Checkout` in the page, with actions that record what they were asked. */
function mount(view?: View, options: { refused?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const calls: Calls = { pay: [], retry: [], startOver: 0, choose: [], confirm: [], email: [] };
  /** What the next action resolves with; a test may hold it open. */
  let settle: Promise<void> = Promise.resolve();
  const actions: Actions = {
    confirm: (checked) => calls.confirm.push(checked),
    choosePayout: (index) => calls.choose.push(index),
    confirmOldPrompt: async () => undefined,
    cancelOldPrompt: () => undefined,
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
  };
  let props: DrawProps = { ...(view === undefined ? {} : { view }) };
  const draw = (next: DrawProps) => {
    props = { ...props, ...next };
    act(() => {
      render(
        <Checkout
          screen={
            options.refused === true
              ? { kind: 'refused', reason: 'no_storage' }
              : { kind: 'loading' }
          }
          {...props}
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
    step: () => container.querySelector('[data-step]')?.getAttribute('data-step'),
    text: () => container.textContent ?? '',
    alerts: () =>
      [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent ?? ''),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function onWallets(view: View) {
  const ui = mount(view);
  ui.click('Choose wallet');
  expect(ui.step()).toBe('wallets');
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

const REVIEW_PROBLEMS: Problem[] = [
  { reason: 'offer_changed' },
  { reason: 'confirm_first' },
  { reason: 'bad_email' },
  { reason: 'offer_refused' },
  { reason: 'too_late' },
];

describe('the step rule', () => {
  it('sends exactly the offer-level problems back to review', () => {
    const review = Object.entries(PROBLEM_STEP)
      .filter(([, step]) => step === 'review')
      .map(([reason]) => reason);
    expect(review.sort()).toEqual(REVIEW_PROBLEMS.map((problem) => problem.reason).sort());
  });

  for (const problem of REVIEW_PROBLEMS) {
    it(`goes back to review for a new ${problem.reason}`, () => {
      const offer = cannedOffer();
      const ui = onWallets(offerView(offer));
      ui.draw({ view: offerView(offer, { problem }) });
      expect(ui.step()).toBe('review');
      expect(ui.alerts().length).toBe(1);
    });
  }

  const KEPT: Problem[] = [
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
  for (const problem of KEPT) {
    it(`stays on wallets and shows ${problem.reason} there`, () => {
      const offer = cannedOffer();
      const ui = onWallets(offerView(offer));
      ui.draw({ view: { kind: 'working', step: 'checking' } });
      ui.draw({ view: offerView(offer, { problem }) });
      expect(ui.step()).toBe('wallets');
      expect(ui.alerts().length).toBe(1);
    });
  }

  it('goes back to review when a warning needs confirming', () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    const warned = cannedOffer({ confirm: ['payout_recently_changed'] });
    ui.draw({ view: offerView(warned, { confirmed: false }) });
    expect(ui.step()).toBe('review');
  });

  it('stays on wallets after a reload that changed nothing, then a network error', () => {
    const ui = onWallets(offerView(cannedOffer()));
    ui.draw({ view: { kind: 'working', step: 'checking' } });
    // A fresh snapshot: new objects, the same values.
    ui.draw({ view: offerView(cannedOffer(), { problem: { reason: 'rpc_error' } }) });
    expect(ui.step()).toBe('wallets');
    expect(ui.text()).toContain('The network could not be reached');
  });

  it('goes back to review and shows the new price when the payout changed', () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    ui.draw({ view: offerView(withPrice(offer, '55', 6_000_000n)) });
    expect(ui.step()).toBe('review');
    expect(ui.container.querySelector('.price')?.textContent).toBe('55 USD');
  });

  it('lands on review after a retry ends back on the offer', () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    ui.draw({
      view: {
        kind: 'waiting_payment',
        asset: USDC_SOLANA_DEVNET,
        canRetry: true,
        wallets: [],
        tempo: false,
        confirm: [],
        confirmed: true,
        unsureLong: false,
      },
    });
    ui.draw({ view: offerView(offer) });
    expect(ui.step()).toBe('review');
  });

  it('keeps the step when a wallet registers, and never shows a problem moved on from', () => {
    const offer = cannedOffer();
    const problem: Problem = { reason: 'bad_email' };
    const ui = mount(offerView(offer, { problem }));
    expect(ui.alerts()).toHaveLength(1);
    ui.click('Choose wallet');
    // `refresh()`: a new view, the same problem object.
    ui.draw({ view: offerView(offer, { problem, wallets: [{ name: 'Backpack' }] }) });
    expect(ui.step()).toBe('wallets');
    expect(ui.alerts()).toHaveLength(0);
    expect(ui.text()).toContain('Backpack');
  });

  it('keeps the step across the old-prompt question', () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    ui.draw({ view: { kind: 'working', step: 'checking' } });
    ui.draw({ view: { kind: 'old_prompt', orders: 1, until: 0 } });
    ui.draw({ view: offerView(offer) });
    expect(ui.step()).toBe('wallets');
  });
});

describe('the email', () => {
  it('shows what was last sent to the session, across steps', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true }));
    const input = () => ui.container.querySelector('input[type="email"]') as HTMLInputElement;
    act(() => {
      input().value = 'buyer@example.com';
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    ui.click('Choose wallet');
    ui.click('Back');
    expect(input().value).toBe('buyer@example.com');
    expect(ui.calls.email.at(-1)).toBe('buyer@example.com');
  });

  it('is reseeded from the session on every offer', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true, email: 'a@example.com' }));
    ui.click('Choose wallet');
    ui.draw({ view: { kind: 'working', step: 'checking' } });
    ui.draw({
      view: offerView(offer, {
        askEmail: true,
        email: 'a@example.com',
        problem: { reason: 'rpc_error' },
      }),
    });
    ui.click('Back');
    const input = ui.container.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input.value).toBe('a@example.com');
  });

  it('is not asked while an open order on the same terms continues', () => {
    const offer = cannedOffer();
    const ui = mount(offerView(offer, { askEmail: true, continuing: 'ordered' }));
    expect(ui.container.querySelector('input[type="email"]')).toBeNull();
    expect(ui.text()).toContain('Your earlier order is still open; an email, if given, was sent');
    ui.draw({ view: offerView(offer, { askEmail: true, continuing: 'created' }) });
    expect(ui.container.querySelector('input[type="email"]')).toBeNull();
    expect(ui.text()).toContain('Your earlier order is being sent; an email, if given, goes');
    ui.draw({ view: offerView(offer, { askEmail: true, continuing: false }) });
    expect(ui.container.querySelector('input[type="email"]')).not.toBeNull();
  });
});

describe('the review step', () => {
  it('keeps Continue disabled until the warnings are confirmed', () => {
    const offer = cannedOffer({ confirm: ['payout_recently_changed'] });
    const ui = mount(offerView(offer, { confirmed: false }));
    expect(ui.button('Continue').disabled).toBe(true);
    const box = ui.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());
    expect(ui.calls.confirm).toEqual([true]);
    ui.draw({ view: offerView(offer, { confirmed: true }) });
    expect(ui.button('Continue').disabled).toBe(false);
  });

  it('lists every warning and notice without opening anything', () => {
    const offer = cannedOffer({
      confirm: ['payout_changed'],
      notices: ['origin_unverifiable', 'owner_unpinned'],
    });
    const ui = mount(offerView(offer, { confirmed: false }));
    const items = [...ui.container.querySelectorAll('.warnings li')].map(
      (item) => item.textContent,
    );
    expect(items).toHaveLength(3);
    expect(ui.container.querySelector('.warnings details')?.hasAttribute('open')).toBe(false);
  });

  it('offers one chip per payout, labelled with its network, and chooses on click', () => {
    const offer = cannedOffer({ payouts: ['solana-devnet', 'tempo-devnet'] });
    const ui = mount(offerView(offer));
    const chips = [...ui.container.querySelectorAll('[role="radio"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'USDC · Solana devnet',
      'pathUSD · Tempo devnet',
    ]);
    expect(chips[0]?.getAttribute('aria-checked')).toBe('true');
    act(() => (chips[1] as HTMLButtonElement).click());
    expect(ui.calls.choose).toEqual([1]);
    expect(ui.button('Continue')).toBeDefined();
  });

  it('labels a single payout under the price, and goes straight to the wallets', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['solana-mainnet'] })));
    expect(ui.container.querySelector('.pay-label')?.textContent).toBe('USDC · Solana mainnet');
    ui.click('Choose wallet');
    expect(ui.step()).toBe('wallets');
  });

  it('shows a Test network badge on devnet only', () => {
    const ui = mount(offerView(cannedOffer({ payouts: ['tempo-devnet'] })));
    expect(ui.text()).toContain('Test network');
    ui.draw({ view: offerView(cannedOffer({ payouts: ['tempo-mainnet'] })) });
    expect(ui.text()).not.toContain('Test network');
  });
});

describe('the wallets step', () => {
  it('goes back to review', () => {
    const ui = onWallets(offerView(cannedOffer()));
    ui.click('Back');
    expect(ui.step()).toBe('review');
  });

  it('names the payment and pays with the wallet clicked', () => {
    const ui = onWallets(offerView(cannedOffer()));
    expect(ui.container.querySelector('.paying')?.textContent).toBe(
      'Paying 49 USDC · Solana devnet',
    );
    ui.click('Solflare');
    expect(ui.calls.pay).toEqual(['Solflare']);
  });

  it('shows a wallet icon only when it is inlined', () => {
    const ui = onWallets(
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

  it('says a Tempo wallet switches the chain', () => {
    const ui = onWallets(
      offerView(cannedOffer({ payouts: ['tempo-mainnet'] }), { wallets: [{ name: 'MetaMask' }] }),
    );
    expect(ui.text()).toContain('switches to Tempo');
  });

  it('links the Solana wallets to install when none is found', () => {
    const ui = onWallets(offerView(cannedOffer(), { wallets: [] }));
    const links = [...ui.container.querySelectorAll('.install a')];
    expect(links.map((link) => link.textContent)).toEqual(['Phantom', 'Solflare']);
    for (const link of links) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');
    }
    expect(ui.text()).toContain('Reload this page after installing');
  });

  it('names MetaMask for Tempo, when none is found and when a wallet failed', () => {
    const offer = cannedOffer({ payouts: ['tempo-devnet'] });
    const ui = onWallets(offerView(offer, { wallets: [] }));
    expect(
      [...ui.container.querySelectorAll('.install a')].map((link) => link.textContent),
    ).toEqual(['MetaMask']);
    ui.draw({
      view: offerView(offer, { wallets: [{ name: 'Other' }], problem: { reason: 'no_wallet' } }),
    });
    expect(ui.alerts().join(' ')).toContain('MetaMask is known to work');
  });

  it('sends a phone to its wallet app’s browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    );
    const ui = onWallets(offerView(cannedOffer(), { wallets: [] }));
    expect(ui.text()).toContain('Open this page in your wallet app’s browser');
    expect(ui.container.querySelector('.install')).toBeNull();
  });
});

describe('progress', () => {
  const asset = USDC_SOLANA_DEVNET;
  const paying = {
    amount: '55000000',
    asset,
    network: 'devnet' as const,
    chain: 'solana' as const,
  };
  const waiting = {
    kind: 'waiting_payment' as const,
    paying,
    asset,
    canRetry: false,
    wallets: [],
    tempo: false,
    confirm: [],
    confirmed: true,
    unsureLong: false,
  };

  it('shows a working step with the payment it is about', () => {
    const ui = mount({ kind: 'working', step: 'signing', paying });
    expect(ui.text()).toContain('Confirm the payment in your wallet');
    expect(ui.container.querySelector('.paying')?.textContent).toBe(
      'Paying 55 USDC · Solana devnet',
    );
    expect(ui.container.querySelector('[aria-current="step"]')?.textContent).toBe(
      'Confirm in wallet',
    );
  });

  it('shows the wait for the payment, then the long-wait advice', () => {
    const ui = mount(waiting);
    expect(ui.text()).toContain('Waiting for the payment to confirm');
    expect(ui.container.querySelector('.paying')?.textContent).toBe(
      'Paying 55 USDC · Solana devnet',
    );
    ui.draw({ view: { ...waiting, unsureLong: true } });
    expect(ui.text()).toContain('This is taking long');
  });

  it('retries only once the warnings are confirmed, or starts over', () => {
    const ui = mount({
      ...waiting,
      canRetry: true,
      wallets: [{ name: 'Phantom' }],
      confirm: ['payout_recently_changed'],
      confirmed: false,
      problem: { reason: 'wallet_failed' },
    });
    expect(ui.button('Phantom').disabled).toBe(true);
    expect(ui.alerts().join(' ')).toContain('The wallet did not sign');
    act(() => (ui.container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(ui.calls.confirm).toEqual([true]);
    ui.draw({
      view: {
        ...waiting,
        canRetry: true,
        wallets: [{ name: 'Phantom' }],
        confirm: ['payout_recently_changed'],
        confirmed: true,
      },
    });
    ui.click('Phantom');
    expect(ui.calls.retry).toEqual(['Phantom']);
    ui.click('Start over');
    expect(ui.calls.startOver).toBe(1);
  });

  it('offers no retry on Tempo, and says to check the wallet', () => {
    const ui = mount({ ...waiting, tempo: true });
    expect(ui.text()).toContain('If your wallet still shows the request');
    expect(ui.buttons().some((each) => each.textContent?.includes('Start over'))).toBe(false);
  });

  it('shows a cancellation after payment as an alert', () => {
    const ui = mount({ kind: 'waiting_store', paying, cancelled: true, noAnswer: true });
    expect(ui.alerts().join(' ')).toContain('the store cancelled this order');
    expect(ui.text()).toContain('The store has not answered for a while');
  });

  it('shows the wait for the store', () => {
    const ui = mount({ kind: 'waiting_store', paying, cancelled: false, noAnswer: false });
    expect(ui.text()).toContain('Paid. Waiting for the store to deliver');
    expect(ui.container.querySelector('[aria-current="step"]')?.textContent).toBe('Delivered');
  });

  it('asks about an old prompt with its two buttons', () => {
    const ui = mount({ kind: 'old_prompt', orders: 1, until: 0 });
    expect(ui.alerts().join(' ')).toContain('may still be open in your wallet');
    expect(ui.button('I understand, continue')).toBeDefined();
    expect(ui.button('Back')).toBeDefined();
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
    expect(ui.container.querySelector('a.button')).toBeNull();
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
    { name: 'review', view: offerView(offer) },
    { name: 'progress', view: { kind: 'working', step: 'checking' } },
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

  it('shows on the wallets step', () => {
    const ui = onWallets(offerView(offer));
    ui.draw({ banner });
    expect(ui.container.querySelector('.banner')).not.toBeNull();
  });
});

describe('the trust chip', () => {
  const cases = [
    { level: 'A' as const, domain: 'shop.example', label: 'Verified: shop.example' },
    { level: 'B' as const, domain: 'elisym.shop', label: 'Named store' },
    { level: 'C' as const, domain: undefined, label: 'Unverified store' },
  ];
  for (const { level, domain, label } of cases) {
    it(`says ${label} at level ${level}, and explains on click`, () => {
      const ui = mount(
        offerView(cannedOffer({ level, ...(domain === undefined ? {} : { domain }) })),
      );
      const chip = ui.container.querySelector('.chip') as HTMLButtonElement;
      expect(chip.textContent).toBe(label);
      expect(ui.container.querySelector('.trust-detail')).toBeNull();
      act(() => chip.click());
      expect(chip.getAttribute('aria-expanded')).toBe('true');
      expect(ui.container.querySelector('.trust-detail')).not.toBeNull();
    });
  }
});

describe('store data', () => {
  it('is rendered as text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const offer = cannedOffer({ name: hostile, title: hostile, summary: hostile });
    const ui = mount(offerView(offer));
    expect(ui.container.querySelectorAll('img[src="x"]')).toHaveLength(0);
    expect(ui.container.querySelector('#store-name')?.textContent).toBe(hostile);
    expect(ui.container.querySelector('.step-heading')?.textContent).toBe(hostile);
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
  const heading = (ui: ReturnType<typeof mount>) => ui.container.querySelector('[data-heading]');

  it('never moves at load', () => {
    const ui = mount(offerView(cannedOffer()));
    expect(document.activeElement).not.toBe(heading(ui));
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });

  it('moves to the new heading on Continue and on Back', () => {
    const ui = mount(offerView(cannedOffer()));
    ui.click('Choose wallet');
    expect(document.activeElement?.textContent).toBe('Choose a wallet');
    ui.click('Back');
    expect(document.activeElement?.textContent).toBe('Agents 101');
  });

  it('moves to the first view a wallet click produces, and no further', async () => {
    let finish = () => undefined as void;
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    ui.hold(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    ui.click('Phantom');
    (document.activeElement as HTMLElement | null)?.blur();
    ui.draw({ view: { kind: 'working', step: 'checking' } });
    expect(document.activeElement?.textContent).toBe('Paying');
    (document.activeElement as HTMLElement | null)?.blur();
    ui.draw({ view: { kind: 'working', step: 'signing' } });
    expect(ui.container.contains(document.activeElement)).toBe(false);
    await act(async () => finish());
  });

  it('is not taken by a view after an action that drew nothing', async () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => ui.button('Phantom').click());
    // The action settled with no view; the watch draws one later.
    ui.draw({ view: { kind: 'waiting_store', cancelled: false, noAnswer: false } });
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });

  it('is not taken when the buyer is elsewhere', () => {
    const offer = cannedOffer();
    const ui = onWallets(offerView(offer));
    (document.activeElement as HTMLElement | null)?.blur();
    ui.hold(new Promise<void>(() => undefined));
    ui.click('Phantom');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    ui.draw({ view: offerView(offer, { problem: { reason: 'rpc_error' } }) });
    expect(ui.container.contains(document.activeElement)).toBe(false);
  });
});
