import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreShell } from '../../src/hosted/components/StoreShell';
import { ApiError } from '../../src/hosted/lib/api';
import { GENERIC_REQUEST_FAILURE } from '../../src/hosted/lib/errors';
import {
  DONE,
  FOLLOW_ATTEMPTS,
  FOLLOW_INTERVAL_MS,
  ON_ACTIVATION,
  STILL_APPLYING,
  TEMPLATE_PROBLEMS,
} from '../../src/hosted/lib/owner-flow';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { CommitAnswer, Payout, RequestView, StoreView } from '../../src/hosted/lib/types';
import { type Mounted, buttonNamed, click, inputById, mount, settle, turns } from '../mount';
import { OPERATOR, OWNER, storeView } from './fakes';
import {
  LEAK,
  NOW,
  OTHER_SOLANA_ADDRESS,
  SOLANA_ADDRESS,
  SOLANA_USDC,
  authorizationTemplate,
  fakeSession,
  payoutListTemplate,
  signed,
  storeConfig,
} from './store-fakes';

const PAYOUTS: Payout[] = [
  { caip19: SOLANA_USDC, address: SOLANA_ADDRESS, signature: 'sig-one' },
  { caip19: SOLANA_USDC, address: OTHER_SOLANA_ADDRESS, signature: 'sig-two' },
];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function needingSigning(overrides: Partial<StoreView> = {}): StoreView {
  return storeView({
    status: 'active',
    config: storeConfig({ draftPayouts: PAYOUTS, revision: 2 }),
    payouts: { needsSigning: true },
    ...overrides,
  });
}

function applied(id: string): RequestView {
  return {
    id,
    kind: 'record_owner_event',
    state: 'applied',
    result: null,
    createdAt: NOW,
    appliedAt: NOW,
  };
}

function pendingAnswer(event: NostrEvent): CommitAnswer {
  return { id: event.id, request: { id: 'r1', state: 'pending' } };
}

async function open(view: StoreView, overrides: Partial<StoreApi> = {}, prove: Payout[] = []) {
  const fake = fakeSession({ store: async () => view, ...overrides });
  for (const payout of prove) {
    fake.session.proven.add(payout.caip19, payout.address);
  }
  mounted = await mount(
    <StoreShell session={fake.session} store={view} onSignOut={() => undefined} />,
  );
  return { ...fake, container: mounted.container };
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function signButton(container: HTMLElement): HTMLButtonElement {
  return buttonNamed(container, 'Sign and publish');
}

describe('publishing the payout list', () => {
  it('lists every address in full, marks the proven one, and needs a tick for the other', async () => {
    const commits: NostrEvent[] = [];
    const { container, signEvent } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => {
          commits.push(event);
          return { id: event.id, request: applied('r1') };
        },
      },
      [PAYOUTS[0] as Payout],
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    expect(container.querySelector('#confirm-address-0')?.textContent).toBe(SOLANA_ADDRESS);
    expect(container.querySelector('#confirm-address-1')?.textContent).toBe(OTHER_SOLANA_ADDRESS);
    expect(container.querySelector('#confirm-tick-0')).toBeNull();
    expect(text(container)).toContain('Signed from this device');
    expect(signButton(container).disabled).toBe(true);
    await click(signButton(container));
    expect(signEvent).not.toHaveBeenCalled();

    await click(inputById(container, 'confirm-tick-1'));
    expect(signButton(container).disabled).toBe(false);
    await click(inputById(container, 'confirm-tick-1'));
    expect(signButton(container).disabled).toBe(true);
    await click(inputById(container, 'confirm-tick-1'));
    await click(signButton(container));
    await settle(() => text(container).includes(DONE));
    expect(commits).toHaveLength(1);
    const [event] = commits;
    expect(event?.pubkey).toBe(OWNER);
    expect(event !== undefined && verifyEvent(event)).toBe(true);
    expect(event?.tags).toEqual(payoutListTemplate(PAYOUTS).tags);
  });

  it('needs no tick when every address was proven in this browser session', async () => {
    const { container } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => ({ id: event.id, request: applied('r1') }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    expect(container.querySelector('input[type=checkbox][id^=confirm-tick]')).toBeNull();
    await click(signButton(container));
    await settle(() => text(container).includes(DONE));
  });

  it.each<[string, EventTemplate, keyof typeof TEMPLATE_PROBLEMS]>([
    ['another payout list', payoutListTemplate([PAYOUTS[0] as Payout]), 'payouts'],
    ['a far-future date', payoutListTemplate(PAYOUTS, NOW + 3600), 'date'],
    [
      'an extra tag',
      {
        ...payoutListTemplate(PAYOUTS),
        tags: [...payoutListTemplate(PAYOUTS).tags, ['expiration', '1']],
      },
      'tags',
    ],
    ['another kind', authorizationTemplate(), 'kind'],
  ])('refuses to sign %s, says why, and commits nothing', async (_name, template, problem) => {
    const commit = vi.fn();
    const { container, signEvent } = await open(needingSigning(), {
      prepareOwnerEvent: async () => ({ template, expiresAt: NOW + 900 }),
      commitOwnerEvent: commit,
    });
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => text(container).includes(TEMPLATE_PROBLEMS[problem]));
    expect(container.querySelector('#confirm-owner-event')).toBeNull();
    expect(signEvent).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('names the coin of an unsigned payout only when the refusal names a known coin', async () => {
    let message = SOLANA_USDC;
    const { container } = await open(needingSigning(), {
      prepareOwnerEvent: async () => {
        throw new ApiError(409, 'unsigned_payout', { message });
      },
    });
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() =>
      text(container).includes('Your USDC on Solana payout address has no wallet signature'),
    );
    message = LEAK;
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => text(container).includes('A payout address has no wallet signature'));
    expect(text(container)).not.toContain('SECRET');
  });

  it('says a payout list that cannot be built in a fixed sentence', async () => {
    const { container } = await open(needingSigning(), {
      prepareOwnerEvent: async () => {
        throw new ApiError(409, 'bad_payouts', { message: LEAK });
      },
    });
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => text(container).includes('cannot be published as a payout list'));
    expect(text(container)).not.toContain('SECRET');
  });

  it('disables the button while it runs, and prepares once for a double press', async () => {
    let answer: (value: { template: EventTemplate; expiresAt: number }) => void = () => undefined;
    const prepare = vi.fn(
      () =>
        new Promise<{ template: EventTemplate; expiresAt: number }>((resolve) => {
          answer = resolve;
        }),
    );
    const { container } = await open(needingSigning(), { prepareOwnerEvent: prepare }, PAYOUTS);
    const button = buttonNamed(container, 'Publish payout list');
    await click(button);
    expect(buttonNamed(container, 'Publish payout list').disabled).toBe(true);
    await click(button);
    expect(prepare).toHaveBeenCalledTimes(1);
    answer({ template: payoutListTemplate(PAYOUTS), expiresAt: NOW + 900 });
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
  });

  it('prepares once for two presses before the page renders again', async () => {
    let answer: (value: { template: EventTemplate; expiresAt: number }) => void = () => undefined;
    const prepare = vi.fn(
      () =>
        new Promise<{ template: EventTemplate; expiresAt: number }>((resolve) => {
          answer = resolve;
        }),
    );
    const { container } = await open(needingSigning(), { prepareOwnerEvent: prepare }, PAYOUTS);
    const button = buttonNamed(container, 'Publish payout list');
    await act(async () => {
      button.click();
      button.click();
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    answer({ template: payoutListTemplate(PAYOUTS), expiresAt: NOW + 900 });
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
  });

  it.each(['mismatch', 'stale', 'clock', 'expired', 'no_draft'])(
    'prepares again once, by itself, when the commit is refused as %s',
    async (code) => {
      const prepare = vi.fn(async () => ({
        template: payoutListTemplate(PAYOUTS, NOW + prepare.mock.calls.length),
        expiresAt: NOW + 900,
      }));
      const commits: NostrEvent[] = [];
      const { container, signEvent } = await open(
        needingSigning(),
        {
          prepareOwnerEvent: prepare,
          commitOwnerEvent: async (event) => {
            commits.push(event);
            if (commits.length === 1) {
              throw new ApiError(409, code);
            }
            return { id: event.id, request: applied('r1') };
          },
        },
        PAYOUTS,
      );
      await click(buttonNamed(container, 'Publish payout list'));
      await settle(() => container.querySelector('#confirm-owner-event') !== null);
      await click(signButton(container));
      await settle(() => text(container).includes(DONE));
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(signEvent).toHaveBeenCalledTimes(2);
      expect(commits.map((event) => event.created_at)).toEqual([NOW + 1, NOW + 2]);
    },
  );

  it('stops after one fresh prepare, and does not prepare again for other refusals', async () => {
    const prepare = vi.fn(async () => ({
      template: payoutListTemplate(PAYOUTS),
      expiresAt: NOW + 900,
    }));
    let code = 'mismatch';
    const { container } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: prepare,
        commitOwnerEvent: async () => {
          throw new ApiError(409, code);
        },
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes('no longer the one waiting'));
    expect(prepare).toHaveBeenCalledTimes(2);

    code = 'signature';
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes('not signed by this owner key'));
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('checks the fresh prepare too: a list that differs from the rows is not signed', async () => {
    const replaced: Payout[] = [PAYOUTS[1] as Payout, PAYOUTS[0] as Payout];
    let round = 0;
    const commit = vi.fn(async (): Promise<CommitAnswer> => {
      throw new ApiError(409, 'mismatch');
    });
    const { container, signEvent } = await open(
      needingSigning({ config: storeConfig({ draftPayouts: PAYOUTS, revision: 2 }) }),
      {
        prepareOwnerEvent: async () => {
          round += 1;
          // The second prepare names the rows in another order: refused by the local check.
          return {
            template: payoutListTemplate(round === 1 ? PAYOUTS : replaced),
            expiresAt: NOW + 900,
          };
        },
        commitOwnerEvent: commit,
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(TEMPLATE_PROBLEMS.payouts));
    expect(signEvent).toHaveBeenCalledTimes(1);
  });

  it('says a pending store goes live on activation, and follows nothing', async () => {
    const request = vi.fn();
    const { container, sleeps } = await open(
      needingSigning({ status: 'pending' }),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => pendingAnswer(event),
        request,
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(ON_ACTIVATION));
    expect(request).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it('follows an active store every 2 s until the request is applied', async () => {
    const states: RequestView['state'][] = ['pending', 'pending', 'applied'];
    const request = vi.fn(async (id: string) => ({
      request: { ...applied(id), state: states.shift() ?? 'applied' },
    }));
    const { container, sleeps } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => pendingAnswer(event),
        request,
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(DONE));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith('r1');
    expect(sleeps).toEqual([FOLLOW_INTERVAL_MS, FOLLOW_INTERVAL_MS, FOLLOW_INTERVAL_MS]);
  });

  it('says "still applying" after 30 s, and Refresh reads the request again', async () => {
    let state: RequestView['state'] = 'pending';
    const request = vi.fn(async (id: string) => ({ request: { ...applied(id), state } }));
    const { container, sleeps } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => pendingAnswer(event),
        request,
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(STILL_APPLYING));
    expect(request).toHaveBeenCalledTimes(FOLLOW_ATTEMPTS);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(30_000);
    state = 'applied';
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => text(container).includes(DONE));
    expect(request).toHaveBeenCalledTimes(FOLLOW_ATTEMPTS + 1);
  });

  it('says a failed request by its code, never its text', async () => {
    const { container } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => ({
          id: event.id,
          request: {
            ...applied('r1'),
            state: 'failed',
            result: { code: 'setup_failed', problem: LEAK },
          },
        }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes('Your store could not apply the change'));
    expect(text(container)).not.toContain('SECRET');
  });

  it('says a failed follow by its code too', async () => {
    const { container } = await open(
      needingSigning(),
      {
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => pendingAnswer(event),
        request: async (id) => ({
          request: { ...applied(id), state: 'failed', result: { code: 'nope' } },
        }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(GENERIC_REQUEST_FAILURE));
  });
});

describe('authorizing PayCore', () => {
  it('says what the store key may do, and signs with no tick', async () => {
    const commits: NostrEvent[] = [];
    const { container } = await open(storeView({ status: 'active' }), {
      prepareOwnerEvent: async (kind) => {
        expect(kind).toBe(30490);
        return { template: authorizationTemplate(), expiresAt: NOW + 900 };
      },
      commitOwnerEvent: async (event) => {
        commits.push(event);
        return { id: event.id, request: applied('r1') };
      },
    });
    await click(buttonNamed(container, 'Authorize PayCore'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    expect(text(container)).toContain(`This authorizes ${OPERATOR}`);
    expect(text(container)).toContain('cannot move your money');
    await click(signButton(container));
    await settle(() => text(container).includes(DONE));
    expect(commits[0]?.tags).toEqual(authorizationTemplate().tags);
  });

  it.each<[string, EventTemplate, keyof typeof TEMPLATE_PROBLEMS]>([
    [
      'another store',
      {
        ...authorizationTemplate(),
        tags: [
          ['d', 'f'.repeat(64)],
          ['p', 'f'.repeat(64)],
          ['mode', 'hosted', OPERATOR],
        ],
      },
      'store',
    ],
    [
      'another operator',
      {
        ...authorizationTemplate(),
        tags: [...authorizationTemplate().tags.slice(0, 2), ['mode', 'hosted', 'evil.example']],
      },
      'operator',
    ],
    [
      'an expiration',
      {
        ...authorizationTemplate(),
        tags: [...authorizationTemplate().tags, ['expiration', String(NOW + 60)]],
      },
      'tags',
    ],
  ])('refuses %s', async (_name, template, problem) => {
    const { container, signEvent } = await open(storeView({ status: 'active' }), {
      prepareOwnerEvent: async () => ({ template, expiresAt: NOW + 900 }),
    });
    await click(buttonNamed(container, 'Authorize PayCore'));
    await settle(() => text(container).includes(TEMPLATE_PROBLEMS[problem]));
    expect(signEvent).not.toHaveBeenCalled();
  });
});

describe('a signed event that is not published', () => {
  it('posts the very event of the view back on Retry, with no prepare and no signature (after a reload)', async () => {
    const event = signed(payoutListTemplate(PAYOUTS));
    const commit = vi.fn(
      async (posted: NostrEvent): Promise<CommitAnswer> => ({
        id: posted.id,
        alreadyCommitted: true,
        request: applied('r2'),
      }),
    );
    const prepare = vi.fn();
    const view = storeView({
      status: 'active',
      config: storeConfig({ draftPayouts: PAYOUTS, revision: 2 }),
      ownerEvents: { payto: { event, committedAt: NOW, publishedAt: null }, auth: null },
    });
    const { container, signEvent } = await open(view, {
      prepareOwnerEvent: prepare,
      commitOwnerEvent: commit,
    });
    expect(container.querySelector('#payto-status')?.textContent).toBe(
      'Signed, not published yet.',
    );
    await click(buttonNamed(container, 'Retry publishing'));
    await settle(() => text(container).includes(DONE));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toBe(event);
    expect(prepare).not.toHaveBeenCalled();
    expect(signEvent).not.toHaveBeenCalled();
  });

  it('offers no Retry for a pending store: it publishes at activation', async () => {
    const event = signed(authorizationTemplate());
    const { container } = await open(
      storeView({
        status: 'pending',
        ownerEvents: { payto: null, auth: { event, committedAt: NOW, publishedAt: null } },
      }),
    );
    expect(container.querySelector('#auth-status')?.textContent).toContain(
      'goes live when PayCore activates',
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Retry publishing',
      ),
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Authorize PayCore',
      ),
    ).toBe(false);
  });

  it('shows a published event as such', async () => {
    const event = signed(authorizationTemplate());
    const { container } = await open(
      storeView({
        status: 'active',
        ownerEvents: { payto: null, auth: { event, committedAt: NOW, publishedAt: NOW } },
      }),
    );
    expect(container.querySelector('#auth-status')?.textContent).toBe('Signed and published.');
    await turns(2);
  });
});

describe('review round 1', () => {
  const EVM = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const EVM_ADDRESS = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';

  it('signs a fresh prepare that passes the check with no second confirm, even when an EVM address differs only in case', async () => {
    const payouts: Payout[] = [{ caip19: EVM, address: EVM_ADDRESS, signature: '0xsig' }];
    const upper: Payout[] = [
      { ...payouts[0], address: '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED' } as Payout,
    ];
    let round = 0;
    const commits: NostrEvent[] = [];
    const { container, signEvent } = await open(
      needingSigning({ config: storeConfig({ draftPayouts: payouts, revision: 2 }) }),
      {
        prepareOwnerEvent: async () => {
          round += 1;
          return {
            template: payoutListTemplate(round === 1 ? payouts : upper, NOW + round),
            expiresAt: NOW + 900,
          };
        },
        commitOwnerEvent: async (event) => {
          commits.push(event);
          if (commits.length === 1) {
            throw new ApiError(409, 'mismatch');
          }
          return { id: event.id, request: applied('r1') };
        },
      },
      payouts,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => text(container).includes(DONE));
    expect(signEvent).toHaveBeenCalledTimes(2);
    expect(commits[1]?.tags).toEqual(payoutListTemplate(upper).tags);
  });

  it('keeps the button, disabled, while it runs although the event stopped being needed', async () => {
    const { OwnerEventAction } = await import('../../src/hosted/components/OwnerEventAction');
    let answer: (value: { template: EventTemplate; expiresAt: number }) => void = () => undefined;
    const fake = fakeSession({
      prepareOwnerEvent: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const element = (needed: boolean) => (
      <OwnerEventAction
        kind={10133}
        label="Publish payout list"
        session={fake.session}
        storePubkey={needingSigning().storePubkey}
        pendingStore={false}
        payouts={PAYOUTS}
        needed={needed}
        onCommitted={() => undefined}
      />
    );
    mounted = await mount(element(true));
    const { container } = mounted;
    await click(buttonNamed(container, 'Publish payout list'));
    await mounted.rerender(element(false));
    expect(buttonNamed(container, 'Publish payout list').disabled).toBe(true);
    answer({ template: payoutListTemplate(PAYOUTS), expiresAt: NOW + 900 });
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(buttonNamed(container, 'Cancel'));
    expect(container.querySelector('button')).toBeNull();
  });

  it('reloads the store once the commit is taken, then stops following once the page is left', async () => {
    const { OwnerEventAction } = await import('../../src/hosted/components/OwnerEventAction');
    const wakes: (() => void)[] = [];
    const request = vi.fn(async (id: string) => ({
      request: { ...applied(id), state: 'pending' as const },
    }));
    const fake = fakeSession({
      prepareOwnerEvent: async () => ({
        template: payoutListTemplate(PAYOUTS),
        expiresAt: NOW + 900,
      }),
      commitOwnerEvent: async (event) => pendingAnswer(event),
      request,
    });
    fake.session.sleep = () =>
      new Promise<void>((resolve) => {
        wakes.push(resolve);
      });
    for (const payout of PAYOUTS) {
      fake.session.proven.add(payout.caip19, payout.address);
    }
    const onCommitted = vi.fn();
    mounted = await mount(
      <OwnerEventAction
        kind={10133}
        label="Publish payout list"
        session={fake.session}
        storePubkey={needingSigning().storePubkey}
        pendingStore={false}
        payouts={PAYOUTS}
        needed
        onCommitted={onCommitted}
      />,
    );
    const { container } = mounted;
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => wakes.length === 1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    mounted = undefined;
    await act(async () => {
      wakes.shift()?.();
    });
    await turns(5);
    expect(request).not.toHaveBeenCalled();
    expect(wakes).toEqual([]);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('leaves the store read again when the merchant switches tabs mid-follow', async () => {
    const wakes: (() => void)[] = [];
    let view = needingSigning();
    const { container, session } = await open(
      view,
      {
        store: async () => view,
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => {
          view = needingSigning({
            payouts: { needsSigning: false },
            ownerEvents: { payto: { event, committedAt: NOW, publishedAt: null }, auth: null },
          });
          return pendingAnswer(event);
        },
        request: async (id) => ({ request: { ...applied(id), state: 'pending' as const } }),
      },
      PAYOUTS,
    );
    session.sleep = () =>
      new Promise<void>((resolve) => {
        wakes.push(resolve);
      });
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(() => wakes.length === 1);
    await click(buttonNamed(container, 'Settings'));
    await click(buttonNamed(container, 'Overview'));
    await settle(() => container.querySelector('#payto-status') !== null);
    expect(container.querySelector('#payto-status')?.textContent).toBe(
      'Signed, not published yet.',
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Publish payout list',
      ),
    ).toBe(false);
    await act(async () => {
      wakes.shift()?.();
    });
  });

  it('reloads the store once a Retry is taken, then stops following it once the page is left', async () => {
    const { OwnerEventStatus } = await import('../../src/hosted/components/OwnerEventStatus');
    const event = signed(authorizationTemplate());
    const wakes: (() => void)[] = [];
    const request = vi.fn(async (id: string) => ({
      request: { ...applied(id), state: 'pending' as const },
    }));
    const fake = fakeSession({ commitOwnerEvent: async () => pendingAnswer(event), request });
    fake.session.sleep = () =>
      new Promise<void>((resolve) => {
        wakes.push(resolve);
      });
    const onChanged = vi.fn();
    mounted = await mount(
      <OwnerEventStatus
        id="auth"
        committed={{ event, committedAt: NOW, publishedAt: null }}
        pendingStore={false}
        session={fake.session}
        onChanged={onChanged}
      />,
    );
    await click(buttonNamed(mounted.container, 'Retry publishing'));
    await settle(() => wakes.length === 1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await mounted.unmount();
    mounted = undefined;
    await act(async () => {
      wakes.shift()?.();
    });
    await turns(5);
    expect(request).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('checks a payout list against what this page saved until the config moves past that save', async () => {
    const mine: Payout[] = [PAYOUTS[0] as Payout];
    const theirs: Payout[] = [PAYOUTS[1] as Payout];
    let view = storeView({
      status: 'active',
      config: storeConfig({ draftPayouts: mine, revision: 2 }),
    });
    let saves = 0;
    const { container, signEvent } = await open(
      view,
      {
        putConfig: async (input) => {
          saves += 1;
          if (saves > 1) {
            throw new ApiError(409, 'stale_config');
          }
          return {
            config: storeConfig({ draftPayouts: input.payouts, revision: 3 }),
            requestId: null,
          };
        },
        store: async () => view,
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(theirs),
          expiresAt: NOW + 900,
        }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Payouts'));
    // Saved here at revision 3, yet the server's draft at that revision names another address.
    view = storeView({
      status: 'active',
      config: storeConfig({ draftPayouts: theirs, revision: 3 }),
      payouts: { needsSigning: true },
    });
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes('Payouts saved.'));
    await settle(() =>
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Publish payout list',
      ),
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => text(container).includes(TEMPLATE_PROBLEMS.payouts));
    expect(signEvent).not.toHaveBeenCalled();

    // Changed elsewhere since (revision 4, read again after a stale save): checked against that draft.
    view = storeView({
      status: 'active',
      config: storeConfig({ draftPayouts: theirs, revision: 4 }),
      payouts: { needsSigning: true },
    });
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => inputById(container, 'payout-address-0').value === OTHER_SOLANA_ADDRESS);
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
  });
});

describe('the store read after a follow', () => {
  function committedView(event: NostrEvent, publishedAt: number | null): StoreView {
    return needingSigning({
      payouts: { needsSigning: false },
      ownerEvents: { payto: { event, committedAt: NOW, publishedAt }, auth: null },
    });
  }

  it('reads the store again when the request applies, and shows it published', async () => {
    let committed: NostrEvent | undefined;
    let applied_ = false;
    const store = vi.fn(async () =>
      committed === undefined ? needingSigning() : committedView(committed, applied_ ? NOW : null),
    );
    const { container } = await open(
      needingSigning(),
      {
        store,
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => {
          committed = event;
          return pendingAnswer(event);
        },
        request: async (id) => {
          applied_ = true;
          return { request: applied(id) };
        },
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(
      () => container.querySelector('#payto-status')?.textContent === 'Signed and published.',
    );
    expect(store).toHaveBeenCalledTimes(2);
  });

  it('reads the store again when a Retry applies, and shows it published', async () => {
    const event = signed(payoutListTemplate(PAYOUTS));
    let appliedNow = false;
    const store = vi.fn(async () => committedView(event, appliedNow ? NOW : null));
    const { container } = await open(committedView(event, null), {
      store,
      commitOwnerEvent: async () => pendingAnswer(event),
      request: async (id) => {
        appliedNow = true;
        return { request: applied(id) };
      },
    });
    await click(buttonNamed(container, 'Retry publishing'));
    await settle(
      () => container.querySelector('#payto-status')?.textContent === 'Signed and published.',
    );
    expect(store).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer view when an older read lands after it', async () => {
    let committed: NostrEvent | undefined;
    let release: () => void = () => undefined;
    const store = vi.fn(async (): Promise<StoreView> => {
      if (committed === undefined) {
        return needingSigning();
      }
      const event = committed;
      if (store.mock.calls.length === 1) {
        // The read at acceptance answers last.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return committedView(event, null);
      }
      return committedView(event, NOW);
    });
    const { container } = await open(
      needingSigning(),
      {
        store,
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => {
          committed = event;
          return pendingAnswer(event);
        },
        request: async (id) => ({ request: applied(id) }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(
      () => container.querySelector('#payto-status')?.textContent === 'Signed and published.',
    );
    await act(async () => {
      release();
    });
    await turns(5);
    expect(container.querySelector('#payto-status')?.textContent).toBe('Signed and published.');
  });

  it('shows no warning from an older read that failed after a newer good one', async () => {
    let committed: NostrEvent | undefined;
    let fail: () => void = () => undefined;
    const store = vi.fn(async (): Promise<StoreView> => {
      if (committed === undefined) {
        return needingSigning();
      }
      const event = committed;
      if (store.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          fail = resolve;
        });
        throw new ApiError(0, 'network');
      }
      return committedView(event, NOW);
    });
    const { container } = await open(
      needingSigning(),
      {
        store,
        prepareOwnerEvent: async () => ({
          template: payoutListTemplate(PAYOUTS),
          expiresAt: NOW + 900,
        }),
        commitOwnerEvent: async (event) => {
          committed = event;
          return pendingAnswer(event);
        },
        request: async (id) => ({ request: applied(id) }),
      },
      PAYOUTS,
    );
    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(signButton(container));
    await settle(
      () => container.querySelector('#payto-status')?.textContent === 'Signed and published.',
    );
    await act(async () => {
      fail();
    });
    await turns(5);
    expect(text(container)).not.toContain('could not be reached');
  });
});
