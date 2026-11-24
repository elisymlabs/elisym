import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTHING_ON_SALE } from '../../src/hosted/components/EmbedTab';
import { FINAL_FIRST, HAND_TEXTS } from '../../src/hosted/components/HandAnswerForm';
import { NEEDS_ANSWER, ORDERS_KEPT, OrdersTab } from '../../src/hosted/components/OrdersTab';
import { StoreShell } from '../../src/hosted/components/StoreShell';
import { ApiError } from '../../src/hosted/lib/api';
import { GENERIC_REQUEST_FAILURE } from '../../src/hosted/lib/errors';
import { AMOUNT_PROBLEMS } from '../../src/hosted/lib/hand-answer';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { HandInput, OrderView, OrdersView, StoreView } from '../../src/hosted/lib/types';
import { type Mounted, buttonNamed, click, inputById, mount, settle, turns } from '../mount';
import { storeView } from './fakes';
import {
  BASE_SEPOLIA_USDC,
  LEAK,
  NOW,
  SOLANA_ADDRESS,
  SOLANA_USDC,
  fakeSession,
  storeConfig,
} from './store-fakes';

const BUYER = 'b'.repeat(64);
const TX = '5'.repeat(88);
const PAID = {
  signature: TX,
  amount: '5000000',
  fee: '50000',
  caip19: SOLANA_USDC,
  medium: 'solana',
  blockTime: NOW,
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(container: HTMLElement, id: string, value: string) {
  const select = container.querySelector(`#${id}`);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`no select #${id}`);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function order(orderId: string, overrides: Partial<OrderView> = {}): OrderView {
  return {
    key: `${BUYER}:${orderId}`,
    buyerPubkey: BUYER,
    orderId,
    product: `30402:${'s'.repeat(64)}:socks`,
    productTitle: 'Socks',
    createdAt: NOW,
    reportedTxs: [],
    ...overrides,
  };
}

function activeView(overrides: Partial<StoreView> = {}): StoreView {
  return storeView({
    status: 'active',
    config: storeConfig({
      draftPayouts: [{ caip19: SOLANA_USDC, address: SOLANA_ADDRESS, signature: 'sig' }],
    }),
    ...overrides,
  });
}

const OPEN_ORDERS: OrdersView = {
  orders: [
    order('older', { createdAt: NOW - 100, email: 'ann@example.com' }),
    order('stuck', { createdAt: NOW - 50, customerRef: 'ACC-1' }),
    order('done', {
      createdAt: NOW,
      paid: PAID,
      deliveredAt: NOW + 60,
      webhook: { state: 'sent', attempts: 2, lastStatus: 200 },
      productTitle: null,
    }),
  ],
  answeredByHand: {},
  unresolvedPayments: [{ key: `${BUYER}:stuck`, tx: 'unresolvedtx', at: NOW }],
};

async function openTab(
  orders: OrdersView | (() => Promise<OrdersView>),
  overrides: Partial<StoreApi> = {},
  view: StoreView = activeView(),
) {
  const onChanged = vi.fn();
  const fake = fakeSession({
    orders: typeof orders === 'function' ? orders : async () => orders,
    ...overrides,
  });
  mounted = await mount(<OrdersTab session={fake.session} view={view} onChanged={onChanged} />);
  const { container } = mounted;
  await settle(() => !text(container).includes('Reading your orders'));
  return { ...fake, container, onChanged };
}

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('li[data-order]')].map(
    (row) => row.getAttribute('data-order')?.split(':')[1] ?? '',
  );
}

function rowButton(container: HTMLElement, orderId: string): HTMLButtonElement {
  const button = container.querySelector(`li[data-order="${BUYER}:${orderId}"] > button`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`no row ${orderId}`);
  }
  return button;
}

function field(container: HTMLElement, name: string): string {
  return container.querySelector(`[data-field="${name}"]`)?.textContent ?? '';
}

const HAND = `hand-${BUYER}_stuck`;

describe('the orders tab', () => {
  it('lists the orders newest first with their state, and says how many need a hand answer', async () => {
    const { container } = await openTab(OPEN_ORDERS);
    expect(rows(container)).toEqual(['done', 'stuck', 'older']);
    const states = [...container.querySelectorAll('li [data-field="state"]')].map(
      (state) => state.textContent,
    );
    expect(states).toEqual(['delivered', 'unresolved payment', 'open']);
    expect(text(container)).toContain(NEEDS_ANSWER(1));
    expect(NEEDS_ANSWER(2)).toContain('2 orders have');
    expect(text(container)).toContain('deleted product');
  });

  it('says there are none, and no hand answer needed', async () => {
    const { container } = await openTab({ orders: [], answeredByHand: {}, unresolvedPayments: [] });
    expect(container.querySelector('#orders-empty')?.textContent).toBe('No orders yet.');
    expect(text(container)).not.toContain('could not match');
    expect(buttonNamed(container, 'Export CSV').disabled).toBe(true);
  });

  it('filters by state and searches the email, customer ref and order id', async () => {
    const { container } = await openTab(OPEN_ORDERS);
    await choose(container, 'orders-filter', 'open');
    expect(rows(container)).toEqual(['older']);
    await choose(container, 'orders-filter', 'all');
    await type(inputById(container, 'orders-search'), 'ACC');
    expect(rows(container)).toEqual(['stuck']);
    await type(inputById(container, 'orders-search'), 'ANN@');
    expect(rows(container)).toEqual(['older']);
    await type(inputById(container, 'orders-search'), 'nothing');
    expect(container.querySelector('#orders-empty')?.textContent).toBe('No order matches.');
    await type(inputById(container, 'orders-search'), '');
    await choose(container, 'orders-filter', 'delivered');
    expect(rows(container)).toEqual(['done']);
  });

  it('opens an order: paid amount, fee, explorer link, delivered at, webhook, current title', async () => {
    const { container } = await openTab(OPEN_ORDERS);
    await click(rowButton(container, 'done'));
    expect(rowButton(container, 'done').getAttribute('aria-expanded')).toBe('true');
    expect(field(container, 'paid')).toBe('5 USDC (USDC on Solana)');
    expect(field(container, 'fee')).toBe('0.05 USDC');
    expect(field(container, 'delivered')).toBe(new Date((NOW + 60) * 1000).toISOString());
    expect(field(container, 'webhook')).toBe('sent; 2 attempts, last answer HTTP 200');
    expect(field(container, 'title')).toBe('deleted product');
    expect(text(container)).toContain('Product (current title)');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    // A paid order has no hand answer.
    expect(container.querySelector(`#${HAND}-final`)).toBeNull();
    await click(rowButton(container, 'done'));
    expect(field(container, 'paid')).toBe('');
  });

  it('exports what is shown as CSV', async () => {
    const { container } = await openTab(OPEN_ORDERS);
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) {
        blobs.push(blob);
      }
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function record(this: HTMLAnchorElement) {
        clicked.push(this);
      },
    );
    await type(inputById(container, 'orders-search'), 'ann');
    await click(buttonNamed(container, 'Export CSV'));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toMatch(/^paycore-orders-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await blobs[0]?.text();
    expect(csv?.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('"older"');
    expect(csv).not.toContain('"stuck"');
  });

  it('says a failed read in a fixed sentence, retries, and keeps the last orders after a later failure', async () => {
    let fail = true;
    const { container } = await openTab(async () => {
      if (fail) {
        throw new ApiError(500, LEAK);
      }
      return OPEN_ORDERS;
    });
    expect(text(container)).toContain('Something went wrong');
    expect(text(container)).not.toContain('SECRET');
    fail = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => rows(container).length === 3);
    fail = true;
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => text(container).includes(ORDERS_KEPT));
    expect(rows(container)).toHaveLength(3);
    fail = false;
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => !text(container).includes(ORDERS_KEPT));
  });

  it('applies only the newest read when an older one lands later', async () => {
    const answers: ((view: OrdersView) => void)[] = [];
    let first = true;
    const { container } = await openTab(() => {
      if (first) {
        first = false;
        return Promise.resolve(OPEN_ORDERS);
      }
      return new Promise<OrdersView>((resolve) => {
        answers.push(resolve);
      });
    });
    await click(buttonNamed(container, 'Refresh'));
    await click(buttonNamed(container, 'Refresh'));
    expect(answers).toHaveLength(2);
    const only = (orderId: string): OrdersView => ({
      orders: [order(orderId)],
      answeredByHand: {},
      unresolvedPayments: [],
    });
    await act(async () => answers[1]?.(only('newest')));
    await act(async () => answers[0]?.(only('older-read')));
    await turns(3);
    expect(rows(container)).toEqual(['newest']);
  });
});

describe('hand answers', () => {
  async function openStuck(overrides: Partial<StoreApi> = {}, view = activeView()) {
    const opened = await openTab(OPEN_ORDERS, overrides, view);
    await click(rowButton(opened.container, 'stuck'));
    return opened;
  }

  it('completes an order once the answer is ticked as final, and follows it until applied', async () => {
    const sent: [string, HandInput][] = [];
    let reads = 0;
    const { container, onChanged, sleeps } = await openStuck({
      handAnswer: async (key, input) => {
        sent.push([key, input]);
        return { request: { id: 'r1', state: 'pending' } };
      },
      request: async (id) => {
        reads += 1;
        return {
          request: {
            id,
            kind: 'hand_answer',
            state: reads < 2 ? 'pending' : 'applied',
            result: null,
            createdAt: NOW,
            appliedAt: null,
          },
        };
      },
    });
    await click(buttonNamed(container, 'Send answer'));
    expect(text(container)).toContain(FINAL_FIRST);
    expect(sent).toEqual([]);
    await click(inputById(container, `${HAND}-final`));
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes(HAND_TEXTS.done));
    expect(sent).toEqual([[`${BUYER}:stuck`, { kind: 'complete' }]]);
    expect(sleeps).toEqual([2000, 2000]);
    // Once when the store took it, once when it was applied.
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(text(container)).not.toContain(FINAL_FIRST);
  });

  it('records a refund in subunits of the chosen coin', async () => {
    const sent: HandInput[] = [];
    const view = activeView({
      config: storeConfig({
        draftPayouts: [
          { caip19: SOLANA_USDC, address: SOLANA_ADDRESS },
          { caip19: BASE_SEPOLIA_USDC, address: '0xab' },
        ],
      }),
    });
    const { container } = await openStuck(
      {
        handAnswer: async (_key, input) => {
          sent.push(input);
          return {
            request: {
              id: 'r1',
              kind: 'hand_answer',
              state: 'applied',
              result: { done: true },
              createdAt: NOW,
              appliedAt: NOW,
            },
          };
        },
      },
      view,
    );
    await click(inputById(container, `${HAND}-refunded`));
    await click(inputById(container, `${HAND}-final`));
    await type(inputById(container, `${HAND}-tx`), ' 0xrefund ');
    await type(inputById(container, `${HAND}-amount`), '1.0000001');
    // Two coins: none is chosen for the merchant.
    await click(buttonNamed(container, 'Send answer'));
    expect(text(container)).toContain('Choose the coin the refund was paid in.');
    await choose(container, `${HAND}-coin`, BASE_SEPOLIA_USDC);
    await click(buttonNamed(container, 'Send answer'));
    expect(text(container)).toContain(AMOUNT_PROBLEMS.decimals);
    await type(inputById(container, `${HAND}-amount`), '2.5');
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes(HAND_TEXTS.done));
    expect(sent).toEqual([
      { kind: 'refunded', tx: '0xrefund', amount: '2500000', asset: BASE_SEPOLIA_USDC },
    ]);
  });

  it('picks the only payout coin by itself, and Refresh reads a still-applying answer again', async () => {
    const sent: HandInput[] = [];
    let applied = false;
    const { container } = await openStuck({
      handAnswer: async (_key, input) => {
        sent.push(input);
        return { request: { id: 'r1', state: 'pending' } };
      },
      request: async (id) => {
        if (!applied) {
          throw new ApiError(0, 'network');
        }
        return {
          request: {
            id,
            kind: 'hand_answer',
            state: 'applied',
            result: null,
            createdAt: NOW,
            appliedAt: NOW,
          },
        };
      },
    });
    await click(inputById(container, `${HAND}-refunded`));
    await click(inputById(container, `${HAND}-final`));
    await type(inputById(container, `${HAND}-tx`), 'tx1');
    await type(inputById(container, `${HAND}-amount`), '3');
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes(HAND_TEXTS.still));
    expect(sent).toEqual([{ kind: 'refunded', tx: 'tx1', amount: '3000000', asset: SOLANA_USDC }]);
    applied = true;
    const refreshes = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Refresh',
    );
    await click(refreshes[refreshes.length - 1] as HTMLButtonElement);
    await settle(() => text(container).includes(HAND_TEXTS.done));
  });

  it('says a failed answer by its code, and a refusal by its code, never the server text', async () => {
    const { container } = await openStuck({
      handAnswer: async () => ({
        request: {
          id: 'r1',
          kind: 'hand_answer',
          state: 'failed',
          result: { code: 'already_answered', problem: LEAK },
          createdAt: NOW,
          appliedAt: NOW,
        },
      }),
    });
    await click(inputById(container, `${HAND}-final`));
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes('This order was already answered by hand.'));
    expect(text(container)).not.toContain('SECRET');

    await mounted?.unmount();
    mounted = undefined;
    let refusals = 0;
    const refused = await openStuck({
      handAnswer: async () => {
        refusals += 1;
        throw new ApiError(409, 'suspended', { message: LEAK });
      },
    });
    await click(inputById(refused.container, `${HAND}-final`));
    await click(buttonNamed(refused.container, 'Send answer'));
    await settle(() => text(refused.container).includes('Your store is suspended'));
    expect(text(refused.container)).not.toContain('SECRET');
    // The form stays, and a retry is sent.
    expect(buttonNamed(refused.container, 'Send answer').disabled).toBe(false);
    await click(buttonNamed(refused.container, 'Send answer'));
    await turns(3);
    expect(refusals).toBe(2);
  });

  it('says an unknown failure generically', async () => {
    const { container } = await openStuck({
      handAnswer: async () => ({
        request: {
          id: 'r1',
          kind: 'hand_answer',
          state: 'failed',
          result: { code: 'toString' },
          createdAt: NOW,
          appliedAt: NOW,
        },
      }),
    });
    await click(inputById(container, `${HAND}-final`));
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes(GENERIC_REQUEST_FAILURE));
  });

  it('sends one answer for a double click', async () => {
    let calls = 0;
    const { container } = await openStuck({
      handAnswer: async () => {
        calls += 1;
        return { request: { id: 'r1', state: 'pending' } };
      },
      request: async (id) => ({
        request: {
          id,
          kind: 'hand_answer',
          state: 'applied',
          result: null,
          createdAt: NOW,
          appliedAt: NOW,
        },
      }),
    });
    await click(inputById(container, `${HAND}-final`));
    const button = buttonNamed(container, 'Send answer');
    await act(async () => {
      button.click();
      button.click();
    });
    await settle(() => text(container).includes(HAND_TEXTS.done));
    expect(calls).toBe(1);
  });

  it('keeps saying how the answer ended once the order is answered and the orders are read again', async () => {
    let answered = false;
    const { container } = await openTab(
      async () =>
        answered
          ? {
              orders: OPEN_ORDERS.orders.filter((listed) => listed.orderId !== 'stuck'),
              answeredByHand: { [`${BUYER}:stuck`]: { kind: 'delivered' } },
              unresolvedPayments: [],
            }
          : OPEN_ORDERS,
      {
        handAnswer: async () => {
          answered = true;
          return {
            request: {
              id: 'r1',
              kind: 'hand_answer',
              state: 'applied',
              result: null,
              createdAt: NOW,
              appliedAt: NOW,
            },
          };
        },
      },
    );
    await choose(container, 'orders-filter', 'unresolved');
    await click(rowButton(container, 'stuck'));
    await click(inputById(container, `${HAND}-final`));
    await click(buttonNamed(container, 'Send answer'));
    await settle(() => text(container).includes(HAND_TEXTS.done));
    await turns();
    // Answered and closed, yet still shown under the filter, with how it ended.
    expect(rows(container)).toEqual(['stuck']);
    expect(text(container)).toContain(HAND_TEXTS.done);
    expect(field(container, 'hand')).toBe('completed by hand');
    expect(text(container)).not.toContain('could not match');
  });
});

describe('an order answered by hand', () => {
  it('offers no hand answer and counts none, though a payment on it is still listed', async () => {
    const { container } = await openTab({
      orders: [order('stuck')],
      answeredByHand: { [`${BUYER}:stuck`]: { kind: 'delivered' } },
      unresolvedPayments: [{ key: `${BUYER}:stuck`, tx: 'unresolvedtx', at: NOW }],
    });
    expect(text(container)).not.toContain('could not match');
    await click(rowButton(container, 'stuck'));
    expect(field(container, 'hand')).toBe('completed by hand');
    expect(container.querySelector(`#${HAND}-final`)).toBeNull();
  });
});

describe('the store tabs', () => {
  it('offers Overview, Products, Orders, Payouts, Settings and Embed, and opens Orders', async () => {
    const view = activeView();
    const fake = fakeSession({ store: async () => view, orders: async () => OPEN_ORDERS });
    mounted = await mount(
      <StoreShell session={fake.session} store={view} onSignOut={() => undefined} />,
    );
    const { container } = mounted;
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Products',
      'Orders',
      'Payouts',
      'Settings',
      'Embed',
    ]);
    await click(buttonNamed(container, 'Orders'));
    await settle(() => rows(container).length === 3);
    expect(container.querySelector('#tab-orders')?.getAttribute('aria-selected')).toBe('true');
    await click(buttonNamed(container, 'Products'));
    expect(container.querySelector('#tab-products')?.getAttribute('aria-selected')).toBe('true');
    await settle(() => text(container).includes('Add product'));
    await click(buttonNamed(container, 'Embed'));
    expect(container.querySelector('#tab-embed')?.getAttribute('aria-selected')).toBe('true');
    await settle(() => text(container).includes(NOTHING_ON_SALE));
  });
});
