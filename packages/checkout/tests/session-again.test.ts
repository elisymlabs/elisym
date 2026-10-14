import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { type LoadedOffer, type OrderRecord, OrderStore, loadOffer } from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryRelays,
  NOW,
  type Shop,
  inboxList,
  makeShop,
} from '../../commerce/tests/buyer/fixtures';
import {
  EMPTY_ACCOUNT_RENT,
  FakeSolana,
  FakeWallet,
  signatureOf,
} from '../../commerce/tests/buyer/solana-fixtures';
import {
  type Problem,
  type SessionDeps,
  type View,
  CheckoutSession,
  type WalletOption,
} from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import type { CheckoutState } from '../src/embed/protocol';
import { NO_FEE_TERMS } from './fee-fixtures';
import { holdRpc } from './reset-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

type Ready = Extract<LoadedOffer, { ok: true }>;
type Waiting = Extract<View, { kind: 'waiting_payment' }>;

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
});

/** Intervals the test runs by hand. */
class Timers {
  private next = 1;
  readonly running = new Map<number, () => void>();
  set = (handler: () => void) => {
    const id = this.next;
    this.next += 1;
    this.running.set(id, handler);
    return id;
  };
  clear = (id: unknown) => {
    this.running.delete(id as number);
  };
  async tick(): Promise<void> {
    for (const handler of [...this.running.values()]) {
      handler();
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loaded(shop: Shop, relays: MemoryRelays, now = NOW): Promise<Ready> {
  const offer = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana'],
    now,
  });
  if (!offer.ok) {
    throw new Error(offer.message);
  }
  return offer;
}

/** The session's private state these tests read, and the few switches they flip. */
interface Internals {
  record: OrderRecord | undefined;
  againOffer: { handle: { orderId: string; attemptId: string; payer: string } } | undefined;
  againFlags:
    | { attemptId: string; expiring?: true; seenOnChain?: true; signedNotSent?: true }
    | undefined;
  attemptProblem: { problem: Problem; attemptId: string | undefined } | undefined;
  watchTimer: unknown;
  retrying: boolean;
  attemptOver: boolean;
  followOnly: unknown;
  refusedHere: unknown;
  lateHash: unknown;
  pendingAnswers: Map<string, OrderRecord>;
  unanswered: unknown;
  marked: OrderRecord | undefined;
  followers: Map<string, unknown>;
  busy: boolean;
  payout: { amount: bigint };
}

function internals(session: CheckoutSession): Internals {
  return session as unknown as Internals;
}

async function setup() {
  const shop = makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const offer = await loaded(shop, relays);
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const timers = new Timers();
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  const connects = { count: 0, error: undefined as unknown };
  /** The wallet the page offers; a test may take it away or make it another account. */
  const options: WalletOption[] = [
    {
      name: 'Fake',
      connect: async () => {
        connects.count += 1;
        if (connects.error !== undefined) {
          throw connects.error;
        }
        return current.wallet;
      },
    },
  ];
  const current = { wallet: wallet as FakeWallet, rpc: chain.rpc };
  /** A store whose next `failGets` reads throw. */
  const flaky = Object.create(store) as OrderStore;
  const reads = { failGets: 0, hold: undefined as Promise<void> | undefined };
  flaky.get = async (orderId: string) => {
    const hold = reads.hold;
    if (hold !== undefined) {
      reads.hold = undefined;
      await hold;
    }
    if (reads.failGets > 0) {
      reads.failGets -= 1;
      throw new Error('storage failed');
    }
    return store.get(orderId);
  };
  let clock = NOW + 30;
  const deps: SessionDeps = {
    store: flaky,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => current.rpc,
    feeTerms: NO_FEE_TERMS,
    wallets: () => options,
    reloadOffer: async () => loaded(shop, relays, clock),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: (state) => statuses.push(state),
  };
  const session = new CheckoutSession(offer, deps);
  return {
    shop,
    relays,
    offer,
    wallet,
    chain,
    timers,
    views,
    statuses,
    deps,
    session,
    options,
    connects,
    current,
    reads,
    advance: (seconds: number) => {
      clock += seconds;
    },
    last: () => views.at(-1),
  };
}

type Run = Awaited<ReturnType<typeof setup>>;

async function recordOf(offer: Ready): Promise<OrderRecord> {
  const [record] = await store.forProduct(offer.productAddress);
  if (record === undefined) {
    throw new Error('no record');
  }
  return record;
}

/** The last view, as the wait it must be. */
function waiting(run: Run): Waiting {
  const view = run.last();
  if (view?.kind !== 'waiting_payment') {
    throw new Error(`expected the wait, got ${view?.kind ?? 'nothing'}`);
  }
  return view;
}

/** A first ask the wallet failed: the wait, with the wallet offered again. */
async function failedOnce(options: { lamports?: bigint } = {}): Promise<Run> {
  const run = await setup();
  if (options.lamports !== undefined) {
    run.chain.lamports = options.lamports;
  }
  run.wallet.behaviour = 'throw';
  await run.session.start();
  await run.session.pay('Fake');
  run.wallet.behaviour = 'sign';
  expect(waiting(run)).toMatchObject({
    signed: false,
    canRetry: false,
    again: { wallet: 'Fake' },
    problem: { reason: 'wallet_failed' },
  });
  return run;
}

/** The attempt's marker as stored now. */
async function markerOf(run: Run) {
  const marker = (await recordOf(run.offer)).marker;
  if (marker?.rail !== 'solana') {
    throw new Error('no Solana marker');
  }
  return marker;
}

/** Another tab replaces the attempt (a retry of its own): a new marker, same order. */
async function otherTabRetries(run: Run): Promise<void> {
  const current = await recordOf(run.offer);
  if (current.marker === undefined) {
    throw new Error('no marker');
  }
  const replaced = await store.updateMarker(
    current.orderId,
    current.version,
    current.marker.attemptId,
    { ...current.marker, attemptId: 'other-tab-attempt' },
  );
  if (!replaced.ok) {
    throw new Error(replaced.reason);
  }
}

/** The store's status for `record`, published to the relays the widget listens on. */
async function storeSays(run: Run, record: OrderRecord, message: Partial<OrderMessage> = {}) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  await run.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(status, NOW + 100),
      run.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
  await settle();
}

const hasButton = (view: View | undefined) =>
  view?.kind === 'waiting_payment' && view.again !== undefined;

describe('asking the failed wallet again', () => {
  it('asks the same wallet once, in the same attempt, and pays', async () => {
    const run = await failedOnce();
    const before = await markerOf(run);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
    expect(await markerOf(run)).toMatchObject({
      attemptId: before.attemptId,
      signature: expect.any(String),
    });
    expect(waiting(run)).toMatchObject({ signed: true });
    expect(waiting(run)).not.toHaveProperty('again');
    // The first ask's failure no longer holds: it signed.
    expect(waiting(run)).not.toHaveProperty('problem');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('never says the wallet did not sign after it signed, though the store failed next', async () => {
    const run = await failedOnce();
    run.chain.onSend = async () => {
      // The next store read, after the broadcast, throws.
      run.reads.failGets = 1;
    };
    await run.session.signAgain();
    expect(run.reads.failGets).toBe(0);
    const view = waiting(run);
    expect(view.signed).toBe(true);
    expect(view.problem?.reason).not.toBe('wallet_failed');
  });

  it('asks nothing once the session ended during the reads before the wallet', async () => {
    const run = await failedOnce();
    const held = holdRpc(run.chain.rpc, 'getBlockHeight');
    run.current.rpc = held.rpc;
    const press = run.session.signAgain();
    await held.reached;
    run.session.dispose();
    held.release();
    await press;
    await settle();
    expect(run.wallet.requests).toBe(1);
  });

  it('says the checkout failed on its own attempt when the store fails after the probe ended the press', async () => {
    const run = await failedOnce();
    const attemptId = (await markerOf(run)).attemptId;
    run.wallet.duringPrompt = async () => {
      run.chain.expire();
      await run.timers.tick();
      run.deps.store.updateMarker = async () => {
        throw new Error('the transaction was aborted');
      };
    };
    await run.session.signAgain();
    await settle();
    expect(internals(run.session).attemptProblem).toEqual({
      problem: { reason: 'failed' },
      attemptId,
    });
    run.session.refresh();
    expect(waiting(run)).toMatchObject({ canRetry: true, problem: { reason: 'failed' } });
  });

  it('lets a second press during the first one go at once', async () => {
    const run = await failedOnce();
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        await opened;
        return realConnect();
      },
    };
    const first = run.session.signAgain();
    const second = run.session.signAgain();
    const raced = await Promise.race([
      second.then(() => 'second returned'),
      settle().then(() => 'second still running'),
    ]);
    expect(raced).toBe('second returned');
    open();
    await first;
    expect(run.wallet.requests).toBe(2);
    expect(waiting(run)).toMatchObject({ signed: true });
  });

  it('keeps the attempt’s own problem when a press throws', async () => {
    const run = await failedOnce();
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        const wallet = await realConnect();
        run.reads.failGets = 1;
        return wallet;
      },
    };
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ problem: { reason: 'wallet_failed' } });
  });

  it('lets the handle go on a close, and a late failure after it brings none back', async () => {
    const run = await failedOnce();
    run.session.resetOnClose();
    expect(internals(run.session).againOffer).toBeUndefined();
    const again = await failedOnce();
    again.wallet.behaviour = 'throw';
    again.wallet.duringPrompt = async () => {
      again.session.resetOnClose();
    };
    await again.session.signAgain();
    await settle();
    expect(internals(again.session).againOffer).toBeUndefined();
  });

  it('stops the watch and keeps the press while the wallet is open, and the probe after', async () => {
    const run = await failedOnce();
    const seen: { watching: boolean; busy: boolean; shown: View | undefined }[] = [];
    run.wallet.duringPrompt = async () => {
      const shown = run.last();
      // A cancel only ends a press waiting for the connect answer, never one signing.
      run.session.cancel();
      seen.push({
        watching: internals(run.session).watchTimer !== undefined,
        busy: internals(run.session).busy,
        shown,
      });
    };
    const probes: unknown[] = [];
    const onView = run.deps.onView;
    run.deps.onView = (view) => {
      onView(view);
      if (view.kind === 'waiting_payment') {
        probes.push(internals(run.session).unanswered);
      }
    };
    await run.session.signAgain();
    expect(seen).toMatchObject([
      { watching: false, busy: true, shown: { kind: 'working', step: 'signing' } },
    ]);
    expect(waiting(run)).toMatchObject({ signed: true });
    expect((await markerOf(run)).signature).toBeDefined();
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe === undefined)).toBe(true);
  });

  it('draws nothing after a close during the re-read of the order', async () => {
    const run = await failedOnce();
    let open: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      const realConnect = run.options[0]?.connect;
      if (realConnect === undefined) {
        throw new Error('no wallet');
      }
      run.options[0] = {
        name: 'Fake',
        connect: async () => {
          const wallet = await realConnect();
          run.reads.hold = new Promise<void>((release) => {
            open = release;
          });
          resolve();
          return wallet;
        },
      };
    });
    const press = run.session.signAgain();
    await reached;
    await settle();
    run.session.resetOnClose();
    const views = run.views.length;
    const watch = internals(run.session).watchTimer;
    open();
    await press;
    await settle();
    expect(run.views.slice(views).some((view) => view.kind === 'working')).toBe(false);
    expect(internals(run.session).watchTimer).toBe(watch);
    expect(run.wallet.requests).toBe(1);
  });

  it('never lets a cancelled press free the gate of the press after it', async () => {
    const run = await failedOnce();
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    let openFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    let connectsSeen = 0;
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        connectsSeen += 1;
        if (connectsSeen === 1) {
          await firstHeld;
        }
        return realConnect();
      },
    };
    // A delivery waiting to be judged: the second press reads the store before its guard.
    const record = await recordOf(run.offer);
    internals(run.session).pendingAnswers.set('elsewhere', {
      ...record,
      orderId: 'elsewhere',
      state: 'completed',
    });
    const first = run.session.signAgain();
    await settle();
    expect(connectsSeen).toBe(1);
    // The wallet's connect answer is awaited: the buyer may cancel.
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    run.session.cancel();
    await settle();
    let openSecond: () => void = () => undefined;
    run.reads.hold = new Promise<void>((resolve) => {
      openSecond = resolve;
    });
    const second = run.session.signAgain();
    await settle();
    // The cancelled press ends now, while the second one is still before its guard.
    openFirst();
    await first;
    await settle();
    await run.session.signAgain();
    await settle();
    expect(connectsSeen).toBe(1);
    expect(run.wallet.requests).toBe(1);
    openSecond();
    await second;
    expect(run.wallet.requests).toBe(2);
    expect(waiting(run)).toMatchObject({ signed: true });
  });

  it('is a no-op while another action holds the session', async () => {
    const run = await failedOnce();
    let open: () => void = () => undefined;
    run.reads.hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const leaving = run.session.startOver();
    await settle();
    const views = run.views.length;
    await run.session.signAgain();
    expect(run.views.length).toBe(views);
    expect(run.connects.count).toBe(1);
    open();
    await leaving;
    // Start over ran to its own end: the attempt may still land, so it is still followed.
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    expect(run.connects.count).toBe(1);
    expect(run.wallet.requests).toBe(1);
  });

  it('offers again the wallet a retry failed with, and asks that one', async () => {
    const run = await failedOnce();
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({ canRetry: true });
    let otherConnects = 0;
    run.options.push({
      name: 'Other',
      connect: async () => {
        otherConnects += 1;
        return run.wallet;
      },
    });
    run.wallet.behaviour = 'throw';
    await run.session.retry('Other');
    expect(waiting(run)).toMatchObject({ again: { wallet: 'Other' } });
    run.wallet.behaviour = 'sign';
    const fakeConnects = run.connects.count;
    await run.session.signAgain();
    expect(otherConnects).toBe(2);
    expect(run.connects.count).toBe(fakeConnects);
    expect(waiting(run)).toMatchObject({ signed: true });
  });

  it('says the wallet is being asked as it opens, before the probe’s first read', async () => {
    const run = await failedOnce();
    const sessionStore = run.deps.store;
    const realGet = sessionStore.get.bind(sessionStore);
    let armed = false;
    let gets = 0;
    let openProbe: () => void = () => undefined;
    const probeHeld = new Promise<void>((resolve) => {
      openProbe = resolve;
    });
    // The press's own re-read passes; the probe's first read (the next one) waits.
    sessionStore.get = async (orderId: string) => {
      if (armed) {
        gets += 1;
        if (gets === 2) {
          await probeHeld;
        }
      }
      return realGet(orderId);
    };
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        armed = true;
        return realConnect();
      },
    };
    const shown: (View | undefined)[] = [];
    run.wallet.duringPrompt = async () => {
      shown.push(run.last());
      openProbe();
    };
    await run.session.signAgain();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'working', step: 'signing' });
    expect(shown[0]).not.toHaveProperty('unsureAt');
  });

  it('drops what a watch pass begun before the press found, once the press moved on', async () => {
    const run = await failedOnce();
    const held = holdRpc(run.chain.rpc, 'getSignaturesForAddress');
    run.current.rpc = held.rpc;
    // A watch pass of the attempt as it was: it lists the reference, and waits.
    void run.timers.tick();
    await held.reached;
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ signed: true });
    const statuses = run.statuses.length;
    const views = run.views.length;
    // The old pass now finds the payment the press sent: its verdict is not this press's.
    held.release();
    await settle();
    expect((await recordOf(run.offer)).state).toBe('paid');
    expect(run.statuses.slice(statuses)).not.toContain('paid');
    expect(run.views.length).toBe(views);
    // The press's own watch says so on its next pass.
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('drops the answer of a connect cancelled meanwhile, even a decline', async () => {
    const run = await failedOnce();
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    const gates: (() => void)[] = [];
    let calls = 0;
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        calls += 1;
        const call = calls;
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        if (call === 1) {
          throw Object.assign(new Error('declined'), { code: 4001 });
        }
        return realConnect();
      },
    };
    const first = run.session.signAgain();
    await settle();
    run.session.cancel();
    await settle();
    const second = run.session.signAgain();
    await settle();
    expect(calls).toBe(2);
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    const views = run.views.length;
    // The cancelled press's connect is declined now: its answer is dropped.
    gates[0]?.();
    await first;
    await settle();
    expect(
      run.views
        .slice(views)
        .some(
          (view) => view.kind === 'waiting_payment' && view.problem?.reason === 'again_declined',
        ),
    ).toBe(false);
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    gates[1]?.();
    await second;
    expect(waiting(run)).toMatchObject({ signed: true });
  });

  it('never asks again after the store failed once the wallet may have signed', async () => {
    const run = await failedOnce();
    const sessionStore = run.deps.store;
    const realUpdate = sessionStore.updateMarker.bind(sessionStore);
    let throws = 1;
    sessionStore.updateMarker = async (...args: Parameters<OrderStore['updateMarker']>) => {
      if (throws > 0) {
        throws -= 1;
        throw new Error('the transaction was aborted');
      }
      return realUpdate(...args);
    };
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
    expect(await markerOf(run)).not.toHaveProperty('signature');
    const view = waiting(run);
    expect(view).not.toHaveProperty('again');
    // Not "The wallet did not answer.": it may have signed.
    expect(view.problem).toEqual({ reason: 'failed' });
    expect(view.signed).toBe(false);
    // Exactly the view the UI test "says nothing was sent after the checkout failed" draws.
    expect(view).not.toHaveProperty('signedNotSent');
    expect(view).not.toHaveProperty('seenOnChain');
    expect(view).not.toHaveProperty('expiring');
    expect(view.unserved).toBe(false);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
  });

  it('lets go of its own handle only, when the store fails after the wallet', async () => {
    const run = await failedOnce();
    const sessionStore = run.deps.store;
    sessionStore.updateMarker = async () => {
      throw new Error('the transaction was aborted');
    };
    // A newer press's handle, set while this press's wallet was open.
    const newer = {
      handle: Object.freeze({ orderId: 'newer', attemptId: 'newer', payer: run.wallet.address }),
    };
    run.wallet.duringPrompt = async () => {
      internals(run.session).againOffer = newer;
    };
    await run.session.signAgain();
    expect(internals(run.session).againOffer).toBe(newer);
  });

  it('offers no earlier handle after a retry whose store failed once the wallet signed', async () => {
    const run = await failedOnce();
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({ canRetry: true });
    const sessionStore = run.deps.store;
    const realUpdate = sessionStore.updateMarker.bind(sessionStore);
    let writes = 0;
    // The retry's new marker is written; the signature's write throws.
    sessionStore.updateMarker = async (...args: Parameters<OrderStore['updateMarker']>) => {
      writes += 1;
      if (writes === 2) {
        throw new Error('the transaction was aborted');
      }
      return realUpdate(...args);
    };
    await run.session.retry('Fake');
    expect(run.wallet.requests).toBe(2);
    expect(hasButton(run.last())).toBe(false);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
  });

  it('says the wallet changed the transaction though the store failed right after', async () => {
    const run = await failedOnce();
    run.wallet.behaviour = 'swap_blockhash';
    run.wallet.duringPrompt = async () => {
      run.reads.failGets = 1;
    };
    await run.session.signAgain();
    expect(run.reads.failGets).toBe(0);
    expect(waiting(run)).toMatchObject({ problem: { reason: 'wallet_unsupported' } });
    expect(hasButton(run.last())).toBe(false);
  });

  it('lets the handle go before it re-reads the store after a post-sign refusal', async () => {
    const run = await failedOnce();
    run.wallet.duringPrompt = async () => {
      run.chain.listingFails = true;
      // The next store read, afterPay's own, throws.
      run.reads.failGets = 1;
    };
    await run.session.signAgain();
    run.chain.listingFails = false;
    expect(run.reads.failGets).toBe(0);
    // The wallet answered: never its earlier "did not sign", only the checkout's own failure.
    expect(waiting(run)).toMatchObject({ signedNotSent: true, problem: { reason: 'failed' } });
    expect(internals(run.session).againOffer).toBeUndefined();
    expect(hasButton(run.last())).toBe(false);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
  });

  it('draws the probe’s verdict while the wallet is still open', async () => {
    const run = await failedOnce();
    const shown: (View | undefined)[] = [];
    run.wallet.behaviour = 'throw';
    run.wallet.duringPrompt = async () => {
      run.chain.expire();
      await run.timers.tick();
      shown.push(run.last());
    };
    await run.session.signAgain();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'waiting_payment', canRetry: true });
  });

  it('says the answer was not sent when every write of it lost, first ask and again', async () => {
    const first = await setup();
    first.deps.store.updateMarker = async () => ({ ok: false, reason: 'conflict' });
    await first.session.start();
    await first.session.pay('Fake');
    expect(waiting(first)).toMatchObject({
      signed: false,
      signedNotSent: true,
      problem: { reason: 'failed' },
    });
    const run = await failedOnce();
    run.deps.store.updateMarker = async () => ({ ok: false, reason: 'conflict' });
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      signed: false,
      signedNotSent: true,
      problem: { reason: 'failed' },
    });
    expect(hasButton(run.last())).toBe(false);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
  });

  it('draws the wait again when no RPC serves the order after the connect', async () => {
    const run = await failedOnce();
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    const rpc = run.current.rpc;
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        const wallet = await realConnect();
        run.current.rpc = undefined as unknown as typeof rpc;
        return wallet;
      },
    };
    await run.session.signAgain();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', signed: false });
    expect(run.wallet.requests).toBe(1);
    run.current.rpc = rpc;
  });

  it('keeps a failed read’s note on its own attempt, never on one another tab started', async () => {
    const run = await failedOnce();
    const ownAttempt = (await markerOf(run)).attemptId;
    const held = holdRpc(run.chain.rpc, 'getBlockHeight');
    run.current.rpc = held.rpc;
    const press = run.session.signAgain();
    await held.reached;
    // Another tab replaces the attempt; the probe adopts its record.
    await otherTabRetries(run);
    await run.timers.tick();
    expect(internals(run.session).record?.marker?.attemptId).toBe('other-tab-attempt');
    run.chain.blockHeightFails = true;
    held.release();
    await press;
    expect(internals(run.session).attemptProblem).toEqual({
      problem: { reason: 'rpc_error' },
      attemptId: ownAttempt,
    });
    // The watch shows the other tab's attempt: the note was never about it.
    run.chain.blockHeightFails = false;
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('problem');
  });

  it('waits behind a late approval before it checks for a delivery, as a retry does', async () => {
    const run = await failedOnce();
    internals(run.session).lateHash = { orderId: 'elsewhere', hash: '0x1', timer: undefined };
    const record = await recordOf(run.offer);
    internals(run.session).pendingAnswers.set('elsewhere', {
      ...record,
      orderId: 'elsewhere',
      state: 'completed',
    });
    // Were the delivery checked first, its failed read would draw the wait with "failed".
    run.reads.failGets = 1;
    await run.session.signAgain();
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    expect(run.connects.count).toBe(1);
  });

  it('keeps the signed record as the newest copy when the answer lands after a close', async () => {
    const run = await failedOnce();
    run.wallet.duringPrompt = async () => {
      run.session.resetOnClose();
    };
    await run.session.signAgain();
    await settle();
    const stored = await recordOf(run.offer);
    expect(stored.marker).toHaveProperty('signature');
    // Written through the press's own store: the newest known copy, followed in the background.
    const signature = stored.marker?.rail === 'solana' ? stored.marker.signature : undefined;
    const marked = internals(run.session).marked?.marker;
    expect(marked?.rail === 'solana' ? marked.signature : undefined).toBe(signature);
    expect(internals(run.session).followers.has(stored.orderId)).toBe(true);
    expect(internals(run.session).record).toBeUndefined();
  });

  it('asks once for a double press', async () => {
    const run = await failedOnce();
    await Promise.all([run.session.signAgain(), run.session.signAgain()]);
    expect(run.wallet.requests).toBe(2);
    expect(run.connects.count).toBe(2);
  });

  it('keeps the button on a decline, and the page hears no ordered', async () => {
    const run = await failedOnce();
    run.wallet.behaviour = 'reject';
    const statuses = run.statuses.length;
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'wallet_failed', declined: true },
    });
    expect(run.statuses.slice(statuses)).not.toContain('ordered');
    expect((await recordOf(run.offer)).state).toBe('paying');
    // At once, the same wallet.
    run.wallet.behaviour = 'sign';
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(3);
    expect(waiting(run)).toMatchObject({ signed: true });
  });

  it('keeps the button when the wallet fails again', async () => {
    const run = await failedOnce();
    run.wallet.behaviour = 'throw';
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'wallet_failed' },
    });
    expect(waiting(run).problem).not.toHaveProperty('declined');
  });

  it('says a declined connect plainly, and keeps the button', async () => {
    const run = await failedOnce();
    run.connects.error = { code: 4001 };
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'again_declined' },
    });
    run.connects.error = { code: -32002 };
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'wallet_busy' },
    });
    expect(run.wallet.requests).toBe(1);
  });

  it('drops the button once the wallet changed the transaction', async () => {
    const run = await failedOnce();
    run.wallet.behaviour = 'swap_blockhash';
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ problem: { reason: 'wallet_unsupported' } });
    expect(hasButton(run.last())).toBe(false);
    expect(internals(run.session).againOffer).toBeUndefined();
  });

  it('is a no-op for a stale view: the button is judged when pressed', async () => {
    const run = await failedOnce();
    await otherTabRetries(run);
    // The view still shows the button; the session no longer offers it.
    expect(hasButton(run.last())).toBe(true);
    internals(run.session).record = await recordOf(run.offer);
    await run.session.signAgain();
    expect(run.connects.count).toBe(1);
    expect(run.wallet.requests).toBe(1);
  });

  it('opens no wallet for an order found paid by another device', async () => {
    const run = await failedOnce();
    const request = await recordOf(run.offer);
    await run.chain.injectPayment(JSON.parse(request.paymentRequest ?? '{}'));
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect((await recordOf(run.offer)).marker).not.toHaveProperty('signature');
    await run.session.signAgain();
    expect(run.connects.count).toBe(1);
  });

  it('hides the button when each condition flips alone', async () => {
    const flips: [string, (run: Run) => Promise<void>][] = [
      [
        'another tab’s attempt, through the watch',
        async (run) => {
          await otherTabRetries(run);
          await run.timers.tick();
        },
      ],
      [
        'a signature another tab recorded',
        async (run) => {
          const current = await recordOf(run.offer);
          const marker = await markerOf(run);
          await store.updateMarker(current.orderId, current.version, marker.attemptId, {
            ...marker,
            signature: signatureOf(4),
          });
          run.chain.dropSends = true;
          await run.timers.tick();
        },
      ],
      [
        'the store cancelled, heard by the listener',
        async (run) => {
          await storeSays(run, await recordOf(run.offer), {
            status: 'cancelled',
            delivery: undefined,
          });
        },
      ],
      [
        'the wallet gone from the page',
        async (run) => {
          run.options.splice(0, 1);
          run.session.refresh();
        },
      ],
      [
        'that wallet gone, another still there',
        async (run) => {
          run.options.push({ name: 'Other', connect: async () => run.wallet });
          run.options.splice(0, 1);
          run.session.refresh();
        },
      ],
      [
        'the attempt proven over',
        async (run) => {
          internals(run.session).attemptOver = true;
          run.session.refresh();
        },
      ],
      [
        'a page that only follows',
        async (run) => {
          internals(run.session).followOnly = { reason: 'offer_refused', message: 'no' };
          run.session.refresh();
        },
      ],
      [
        'a refusal on re-check',
        async (run) => {
          internals(run.session).refusedHere = { reason: 'offer_refused', message: 'no' };
          run.session.refresh();
        },
      ],
      [
        'a handle of another order',
        async (run) => {
          const offer = internals(run.session).againOffer;
          if (offer === undefined) {
            throw new Error('no handle');
          }
          offer.handle = Object.freeze({ ...offer.handle, orderId: 'another-order' });
          run.session.refresh();
        },
      ],
      [
        'the request about to expire',
        async (run) => {
          internals(run.session).againFlags = {
            attemptId: (await markerOf(run)).attemptId,
            expiring: true,
          };
          run.session.refresh();
        },
      ],
      [
        'a transaction seen on chain',
        async (run) => {
          internals(run.session).againFlags = {
            attemptId: (await markerOf(run)).attemptId,
            seenOnChain: true,
          };
          run.session.refresh();
        },
      ],
    ];
    for (const [name, flip] of flips) {
      const run = await failedOnce();
      await flip(run);
      expect({ name, button: run.views.slice(-1).some(hasButton) }).toEqual({
        name,
        button: false,
      });
      await run.session.signAgain();
      expect({ name, asked: run.wallet.requests }).toEqual({ name, asked: 1 });
    }
  });

  it('shows the flags of the attempt on screen only', async () => {
    const run = await failedOnce();
    internals(run.session).againFlags = { attemptId: 'another', expiring: true, seenOnChain: true };
    run.session.refresh();
    expect(waiting(run)).not.toHaveProperty('expiring');
    expect(waiting(run)).not.toHaveProperty('seenOnChain');
    expect(hasButton(run.last())).toBe(true);
    internals(run.session).againFlags = {
      attemptId: (await markerOf(run)).attemptId,
      signedNotSent: true,
    };
    run.session.refresh();
    expect(waiting(run)).toMatchObject({ signedNotSent: true });
    internals(run.session).attemptOver = true;
    run.session.refresh();
    expect(waiting(run)).not.toHaveProperty('signedNotSent');
  });

  it('hides a problem of an attempt another tab replaced', async () => {
    const run = await failedOnce();
    await otherTabRetries(run);
    await run.timers.tick();
    const view = waiting(run);
    expect(view).not.toHaveProperty('problem');
    expect(view).not.toHaveProperty('again');
  });

  it('names the order’s own terms while it runs, and lets go of them after', async () => {
    const run = await failedOnce();
    const record = await recordOf(run.offer);
    const shown: View[] = [];
    const views = run.views.length;
    // The payout on screen moved meanwhile: the press still names the order's own.
    internals(run.session).payout = {
      ...internals(run.session).payout,
      amount: internals(run.session).payout.amount + 1n,
    };
    await run.session.signAgain();
    shown.push(...run.views.slice(views));
    const working = shown.filter((view) => view.kind === 'working');
    expect(working.length).toBeGreaterThan(0);
    for (const view of working) {
      expect(view).toMatchObject({ paying: { amount: record.amount } });
    }
    expect(internals(run.session).retrying).toBe(false);
  });

  it('waits behind a late approval, and shows a failed delivery check, before any wallet', async () => {
    const late = await failedOnce();
    internals(late.session).lateHash = { orderId: 'elsewhere', hash: '0x1', timer: undefined };
    await late.session.signAgain();
    expect(late.connects.count).toBe(1);
    expect(late.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    const delivery = await failedOnce();
    const record = await recordOf(delivery.offer);
    internals(delivery.session).pendingAnswers.set('elsewhere', {
      ...record,
      orderId: 'elsewhere',
      state: 'completed',
    });
    delivery.reads.failGets = 1;
    await delivery.session.signAgain();
    expect(delivery.connects.count).toBe(1);
    expect(waiting(delivery)).toMatchObject({ problem: { reason: 'failed' } });
  });

  it('shows failed when an old attempt’s problem is all there is after a throw', async () => {
    const run = await failedOnce();
    internals(run.session).attemptProblem = {
      problem: { reason: 'rpc_error' },
      attemptId: 'older-attempt',
    };
    // The re-read after the connect throws: the guard shows what is stored.
    const realConnect = run.options[0]?.connect;
    if (realConnect === undefined) {
      throw new Error('no wallet');
    }
    run.options[0] = {
      name: 'Fake',
      connect: async () => {
        const wallet = await realConnect();
        run.reads.failGets = 1;
        return wallet;
      },
    };
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ problem: { reason: 'failed' } });
    expect(run.wallet.requests).toBe(1);
  });

  it('follows a store-closed order instead of asking', async () => {
    for (const closed of ['cancelled', 'completed'] as const) {
      const run = await failedOnce();
      const record = await recordOf(run.offer);
      // Stored behind the listener's back: only the press's own re-read sees it.
      await store.update(record.orderId, record.version, {
        status: { status: closed, at: NOW + 40 },
      });
      const views = run.views.length;
      await run.session.signAgain();
      expect({ closed, asked: run.wallet.requests }).toEqual({ closed, asked: 1 });
      expect(run.connects.count).toBe(2);
      // Followed as the store left it, with no button.
      expect(hasButton(run.last())).toBe(false);
      // Never even the signing step: nothing was asked of the attempt.
      expect({
        closed,
        signing: run.views
          .slice(views)
          .some((view) => view.kind === 'working' && view.step === 'signing'),
      }).toEqual({ closed, signing: false });
      if (closed === 'cancelled') {
        expect(run.last()).toMatchObject({ kind: 'waiting_payment', signed: false });
      }
    }
  });

  it('has no button after a reload', async () => {
    const run = await failedOnce();
    run.session.dispose();
    const views: View[] = [];
    const again = new CheckoutSession(run.offer, {
      ...run.deps,
      onView: (view) => views.push(view),
    });
    await again.start();
    await settle();
    expect(views.some(hasButton)).toBe(false);
    await again.signAgain();
    expect(run.connects.count).toBe(1);
  });
});

describe('a refusal that keeps the attempt live', () => {
  async function watching(run: Run): Promise<boolean> {
    await settle();
    return internals(run.session).watchTimer !== undefined;
  }

  it('keeps the button and the network note on a failed read, and watches again', async () => {
    const run = await failedOnce();
    run.chain.blockHeightFails = true;
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'rpc_error' },
    });
    expect(waiting(run)).not.toHaveProperty('signedNotSent');
    expect(await watching(run)).toBe(true);
    expect(run.wallet.requests).toBe(1);
    // A transaction seen next: the note goes, the line says it, no button.
    run.chain.blockHeightFails = false;
    run.chain.extraListed = [
      { signature: signatureOf(1), failed: true, slot: BigInt((await markerOf(run)).slot ?? '0') },
    ];
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ seenOnChain: true });
    expect(waiting(run)).not.toHaveProperty('problem');
    expect(waiting(run)).not.toHaveProperty('again');
    expect(await watching(run)).toBe(true);
  });

  it('asks another account to connect the one it started with', async () => {
    const run = await failedOnce();
    run.current.wallet = await FakeWallet.create();
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({
      again: { wallet: 'Fake' },
      problem: { reason: 'other_payer', payer: run.wallet.address },
    });
    expect(await watching(run)).toBe(true);
    expect(run.current.wallet.requests).toBe(0);
  });

  it('says a request about to expire, with no button, and watches again', async () => {
    const run = await failedOnce();
    run.chain.advance(BigInt((await markerOf(run)).lastValidBlockHeight) - run.chain.height);
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ expiring: true });
    expect(waiting(run)).not.toHaveProperty('again');
    expect(waiting(run)).not.toHaveProperty('problem');
    expect(await watching(run)).toBe(true);
  });

  it('says the answer was not sent when the reference could not be read after it', async () => {
    const run = await failedOnce();
    run.wallet.duringPrompt = async () => {
      run.chain.listingFails = true;
    };
    await run.session.signAgain();
    run.chain.listingFails = false;
    expect(waiting(run)).toMatchObject({ signedNotSent: true, canRetry: false });
    expect(waiting(run)).not.toHaveProperty('problem');
    expect(waiting(run)).not.toHaveProperty('again');
    expect(await watching(run)).toBe(true);
    await run.session.signAgain();
    expect(run.wallet.requests).toBe(2);
  });

  it('says a transaction was seen when the reference shows one after the answer', async () => {
    const run = await failedOnce();
    const slot = BigInt((await markerOf(run)).slot ?? '0');
    run.wallet.duringPrompt = async () => {
      run.chain.extraListed = [{ signature: signatureOf(1), failed: true, slot }];
    };
    await run.session.signAgain();
    expect(waiting(run)).toMatchObject({ seenOnChain: true, signedNotSent: true });
    expect(waiting(run)).not.toHaveProperty('again');
    expect(run.chain.sent).toEqual([]);
  });

  it('shows the fee note under the answer not sent, first ask and again', async () => {
    const first = await setup();
    first.wallet.behaviour = 'raise_price';
    first.chain.lamports = EMPTY_ACCOUNT_RENT + 100_000n;
    await first.session.start();
    await first.session.pay('Fake');
    expect(waiting(first)).toMatchObject({
      signedNotSent: true,
      problem: { reason: 'insufficient_sol' },
    });
    expect(waiting(first)).not.toHaveProperty('again');
    expect(await watching(first)).toBe(true);
    const again = await failedOnce({ lamports: EMPTY_ACCOUNT_RENT + 100_000n });
    again.wallet.behaviour = 'raise_price';
    await again.session.signAgain();
    expect(waiting(again)).toMatchObject({
      signedNotSent: true,
      problem: { reason: 'insufficient_sol', available: EMPTY_ACCOUNT_RENT + 100_000n },
    });
    const short = waiting(again).problem;
    expect(
      short?.reason === 'insufficient_sol' && short.needed > EMPTY_ACCOUNT_RENT + 100_000n,
    ).toBe(true);
    expect(waiting(again)).not.toHaveProperty('again');
  });

  it('never offers a retry for a retry whose fee the payer cannot cover', async () => {
    const run = await failedOnce({ lamports: EMPTY_ACCOUNT_RENT + 100_000n });
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({ canRetry: true });
    run.wallet.behaviour = 'raise_price';
    await run.session.retry('Fake');
    expect(waiting(run)).toMatchObject({
      canRetry: false,
      signedNotSent: true,
      problem: { reason: 'insufficient_sol' },
    });
  });

  it('goes through the stored answer first: a store that finished it shows that', async () => {
    const run = await failedOnce();
    const record = await recordOf(run.offer);
    const slot = BigInt((await markerOf(run)).slot ?? '0');
    run.wallet.duringPrompt = async () => {
      run.chain.extraListed = [{ signature: signatureOf(1), failed: true, slot }];
      await storeSays(run, record);
    };
    const views = run.views.length;
    await run.session.signAgain();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    // Never the wait first: the stored answer is the one shown.
    expect(run.views.slice(views).some((view) => view.kind === 'waiting_payment')).toBe(false);
  });
});

describe('an again press that went stale', () => {
  it('asks nothing after a close during the reads before the wallet', async () => {
    const run = await failedOnce();
    const held = holdRpc(run.chain.rpc, 'getBlockHeight');
    run.current.rpc = held.rpc;
    const press = run.session.signAgain();
    await held.reached;
    run.session.resetOnClose();
    held.release();
    await press;
    await settle();
    expect(run.wallet.requests).toBe(1);
    expect(run.views.slice(-1)[0]).toMatchObject({ kind: 'offer' });
  });

  it('asks nothing once the probe found the payment during those reads', async () => {
    const run = await failedOnce();
    const held = holdRpc(run.chain.rpc, 'getBlockHeight');
    run.current.rpc = held.rpc;
    const press = run.session.signAgain();
    await held.reached;
    const record = await recordOf(run.offer);
    const paid = await run.chain.injectPayment(JSON.parse(record.paymentRequest ?? '{}'));
    // Listed as if from before the attempt: only the probe's pass can end the press.
    const landed = run.chain.landed.get(paid);
    if (landed === undefined) {
      throw new Error('not landed');
    }
    landed.slot = 0n;
    await run.timers.tick();
    expect((await recordOf(run.offer)).state).toBe('paid');
    held.release();
    await press;
    await settle();
    expect(run.wallet.requests).toBe(1);
  });

  it('draws nothing for an answer after a close, and lets the handle go', async () => {
    const run = await failedOnce();
    run.wallet.duringPrompt = async () => {
      run.session.resetOnClose();
      run.chain.listingFails = true;
    };
    await run.session.signAgain();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(run.views.slice(-3).some((view) => view.kind === 'waiting_payment')).toBe(false);
    const marker = await markerOf(run);
    expect(marker).not.toHaveProperty('signature');
    expect(internals(run.session).againFlags).toMatchObject({
      attemptId: marker.attemptId,
      signedNotSent: true,
    });
    expect(internals(run.session).againOffer).toBeUndefined();
    // Back on screen, it says the answer was not sent.
    internals(run.session).record = await recordOf(run.offer);
    run.session.refresh();
    expect(waiting(run)).toMatchObject({ signedNotSent: true });
  });

  it('keeps what a stale answer says after the probe ended the press', async () => {
    const run = await failedOnce();
    const slot = BigInt((await markerOf(run)).slot ?? '0');
    run.wallet.duringPrompt = async () => {
      // The attempt provably ends while the wallet is open: the probe ends the press.
      run.chain.expire();
      await run.timers.tick();
      run.chain.extraListed = [{ signature: signatureOf(1), failed: true, slot }];
    };
    await run.session.signAgain();
    await settle();
    expect(internals(run.session).againFlags).toMatchObject({
      seenOnChain: true,
      signedNotSent: true,
    });
    expect(internals(run.session).againOffer).toBeUndefined();
  });

  it('keeps what an attempt’s answers said, and only for that attempt', async () => {
    const run = await failedOnce();
    const record = await recordOf(run.offer);
    const attemptId = (await markerOf(run)).attemptId;
    const late = run.session as unknown as {
      lateAnswer(result: unknown, resets: number): Promise<void>;
    };
    internals(run.session).againFlags = { attemptId, expiring: true, seenOnChain: true };
    await late.lateAnswer({ ok: false, reason: 'conflict', record, attemptId }, 0);
    expect(internals(run.session).againFlags).toEqual({
      attemptId,
      expiring: true,
      seenOnChain: true,
    });
    // An answer about an attempt that is neither the one on screen nor the one flagged: no-op.
    await late.lateAnswer({ ok: false, reason: 'conflict', record, attemptId: 'a-new-attempt' }, 0);
    expect(internals(run.session).againFlags).toEqual({
      attemptId,
      expiring: true,
      seenOnChain: true,
    });
  });

  it('notes what a first late answer says when nothing was noted yet', async () => {
    const run = await setup();
    run.wallet.behaviour = 'raise_price';
    run.chain.lamports = EMPTY_ACCOUNT_RENT + 100_000n;
    run.wallet.duringPrompt = async () => {
      run.session.resetOnClose();
    };
    await run.session.start();
    await run.session.pay('Fake');
    await settle();
    expect(internals(run.session).againFlags).toEqual({
      attemptId: (await markerOf(run)).attemptId,
      signedNotSent: true,
    });
  });

  it('never lets a late answer of an older attempt overwrite what the newer one said', async () => {
    const run = await failedOnce();
    const older = await recordOf(run.offer);
    const olderId = (await markerOf(run)).attemptId;
    await otherTabRetries(run);
    internals(run.session).record = await recordOf(run.offer);
    const newerId = (await markerOf(run)).attemptId;
    const late = run.session as unknown as {
      lateAnswer(result: unknown, resets: number): Promise<void>;
    };
    internals(run.session).againFlags = {
      attemptId: newerId,
      seenOnChain: true,
      signedNotSent: true,
    };
    await late.lateAnswer(
      { ok: false, reason: 'rpc_error', record: older, attemptId: olderId, signedNotSent: true },
      0,
    );
    expect(internals(run.session).againFlags).toEqual({
      attemptId: newerId,
      seenOnChain: true,
      signedNotSent: true,
    });
    // An answer about the attempt on screen starts its own flags: nothing of an older one.
    internals(run.session).againFlags = { attemptId: olderId, expiring: true };
    await late.lateAnswer({ ok: false, reason: 'conflict', record: older, attemptId: newerId }, 0);
    expect(internals(run.session).againFlags).toEqual({ attemptId: newerId });
  });

  it('keeps the handle when a late answer is about another attempt', async () => {
    const run = await failedOnce();
    const record = await recordOf(run.offer);
    const late = run.session as unknown as {
      lateAnswer(result: unknown, resets: number): Promise<void>;
    };
    await late.lateAnswer(
      { ok: false, reason: 'conflict', record, attemptId: 'an-older-attempt' },
      0,
    );
    expect(internals(run.session).againOffer).toBeDefined();
    await late.lateAnswer(
      { ok: false, reason: 'conflict', record, attemptId: (await markerOf(run)).attemptId },
      0,
    );
    expect(internals(run.session).againOffer).toBeUndefined();
  });

  it('keeps the handle for a stale answer that only failed again', async () => {
    const run = await failedOnce();
    run.wallet.behaviour = 'throw';
    run.wallet.duringPrompt = async () => {
      run.chain.expire();
      await run.timers.tick();
    };
    await run.session.signAgain();
    await settle();
    expect(internals(run.session).againOffer).toBeDefined();
  });
});
