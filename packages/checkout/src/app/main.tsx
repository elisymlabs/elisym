import './styles.css';
import { OrderStore, readChainTime } from '@elisym/commerce/buyer';
import { createRelayClient } from '@elisym/commerce/buyer';
import { type Network, chainByCaip2 } from '@elisym/pay-core';
import { type Eip1193Client, createJsonRpcClient } from '@elisym/pay-core/evm';
import { type Rpc, type SolanaRpcApi, createSolanaRpc } from '@solana/kit';
import { finalizeEvent } from 'nostr-tools/pure';
import { render } from 'preact';
import { IndexedDbOrderBackend, openOrderDatabase } from '../core/order-store-idb';
import { decodeCheckoutParams } from '../embed/protocol';
import { type Actions, Checkout } from './Checkout';
import { type Screen, loadWithPins, startWithHint } from './controller';
import { discoverEvmWallets, tempoWalletOptions } from './evm-wallets';
import { acceptHandshake } from './handshake';
import { createHeightAnimator } from './height';
import { armFirstFocus, closeOnEscape } from './modal-frame';
import { holdFrame, startPage } from './page';
import { wireReopen } from './reopen';
import { type Banner, CheckoutSession, type View } from './session';
import type { PurchasesSource } from './ui/PurchasesStep';
import { discoverWallets, payingWallets, solanaChain } from './wallets';

const root = document.getElementById('app');
const params = decodeCheckoutParams(location.hash);
// Declared before discovery: a wallet may announce itself synchronously, inside
// the discovery call, and its callback reads `session`.
let session: CheckoutSession | undefined;
// A wallet that registers after the offer is drawn is offered as soon as it does.
const wallets = discoverWallets(window, () => session?.refresh());
const evmWallets = discoverEvmWallets(window, () => session?.refresh());
const readClient = createRelayClient();
let screen: Screen = { kind: 'waiting' };
let view: View | undefined;
let banner: Banner | undefined;
/** The opened order database's backend: "Your purchases" reads every record through it. */
let backend: IndexedDbOrderBackend | undefined;
/** Bumped when the checkout went back to its first step after the modal closed. */
let resetCount = 0;

// The session's own promises reach the UI: a step change caused by the buyer
// takes focus only until the action that caused it settles.
const actions: Actions = {
  setEmail: (value) => session?.setEmail(value),
  pay: async (name) => session?.pay(name),
  retry: async (name) => session?.retry(name),
  signAgain: async () => session?.signAgain(),
  startOver: async () => session?.startOver(),
  choosePayout: (index) => session?.choosePayout(index),
  confirmOldPrompt: async () => session?.confirmOldPrompt(),
  cancelOldPrompt: () => session?.cancelOldPrompt(),
  cancel: () => session?.cancel(),
};

/** "Your purchases": read from the running session only (none before it starts). */
const purchases: PurchasesSource = {
  purchases: async () => {
    if (session === undefined) {
      throw new Error('no session');
    }
    return session.purchases();
  },
  purchase: async (orderId) => session?.purchase(orderId),
};

/** Shown in the page's modal dialog: the frame can ask to close it. */
const MODAL = params?.display === 'modal';
/** In a modal only: closing it, in any state, brings the first step back. */
const reopen = wireReopen(params?.display, window, {
  reset: () => {
    if (session?.resetOnClose() !== true) {
      return false;
    }
    resetCount += 1;
    draw();
    return true;
  },
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
});
const closeModal = MODAL
  ? () => {
      handshake.post({ type: 'close' });
      reopen?.closedFromFrame();
    }
  : undefined;
const firstFocus = MODAL
  ? armFirstFocus(window, () =>
      document.getElementById('checkout-title')?.focus({ preventScroll: true }),
    )
  : undefined;

function draw(): void {
  if (root !== null) {
    render(
      <Checkout
        screen={screen}
        view={view}
        banner={banner}
        actions={actions}
        purchases={purchases}
        resetCount={resetCount}
        reducedMotion={prefersReducedMotion}
        {...(closeModal === undefined ? {} : { onClose: closeModal })}
      />,
      root,
    );
    if (view !== undefined || screen.kind === 'refused') {
      firstFocus?.ready();
    }
  }
}

function show(next: Screen): void {
  screen = next;
  draw();
}

/** A build variable that is set to something (an empty one counts as unset). */
function configured(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

const MAINNET_RPC_URL = configured(import.meta.env.VITE_SOLANA_RPC_URL_MAINNET);

/** The widget's own Solana RPC per network (build env); the public devnet one by default. */
const RPC_URLS: Partial<Record<Network, string>> = {
  devnet: configured(import.meta.env.VITE_SOLANA_RPC_URL_DEVNET) ?? 'https://api.devnet.solana.com',
  ...(MAINNET_RPC_URL === undefined ? {} : { mainnet: MAINNET_RPC_URL }),
};
const rpcs = new Map<Network, Rpc<SolanaRpcApi>>();

function rpcFor(network: Network): Rpc<SolanaRpcApi> | undefined {
  const url = RPC_URLS[network];
  if (url === undefined) {
    return undefined;
  }
  let rpc = rpcs.get(network);
  if (rpc === undefined) {
    rpc = createSolanaRpc(url);
    rpcs.set(network, rpc);
  }
  return rpc;
}

/** Tempo's chain per network: mainnet, and Moderato (the registry's devnet). */
function tempoCaip2(network: Network): string {
  return network === 'mainnet' ? 'eip155:4217' : 'eip155:42431';
}
const tempoClients = new Map<Network, Eip1193Client>();

/** The widget's Tempo read RPC: the registry's public endpoint (CORS passes from the frame). */
function tempoFor(network: Network): Eip1193Client | undefined {
  const chain = chainByCaip2(tempoCaip2(network));
  const url = chain?.rpcUrls[0];
  if (url === undefined) {
    return undefined;
  }
  let client = tempoClients.get(network);
  if (client === undefined) {
    client = createJsonRpcClient(url);
    tempoClients.set(network, client);
  }
  return client;
}

async function openStore(): Promise<OrderStore | undefined> {
  try {
    backend = new IndexedDbOrderBackend(await openOrderDatabase());
    return new OrderStore(backend);
  } catch {
    return undefined;
  }
}

async function start(pageOrigin: string): Promise<void> {
  // Whatever was posted before the hello was dropped: the page gets the height now.
  heights.flush(contentHeight());
  await startPage({
    params,
    pageOrigin,
    client: readClient,
    openStore,
    frame: window,
    show,
    status: (state) => handshake.status(state),
    holdHeight: () => holdFrame(document.documentElement, heights, contentHeight()),
    run: (offer, store, followOnly, onStatus) => {
      if (params === undefined) {
        return Promise.resolve();
      }
      const started = new CheckoutSession(offer, {
        store,
        readClient,
        clientFor: (buyerSecretKey) =>
          createRelayClient({ auth: async (template) => finalizeEvent(template, buyerSecretKey) }),
        rpcFor,
        wallets: (network) => payingWallets(wallets.list(), solanaChain(network)),
        tempoFor,
        tempoWallets: (network) => {
          const chain = chainByCaip2(tempoCaip2(network));
          return chain === undefined ? [] : tempoWalletOptions(evmWallets.list(), chain);
        },
        onBanner: (next) => {
          banner = next;
          draw();
        },
        // With this store's pins, as on the first load: a re-verification never skips them.
        reloadOffer: () => loadWithPins(params, pageOrigin, { client: readClient, store }),
        now: () => Math.floor(Date.now() / 1000),
        chainTime: readChainTime,
        setInterval: (handler, ms) => window.setInterval(handler, ms),
        clearInterval: (handle) => window.clearInterval(handle as number),
        setTimeout: (handler, ms) => window.setTimeout(handler, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        onView: (next) => {
          view = next;
          draw();
        },
        onStatus,
        readAll: async () => {
          if (backend === undefined) {
            // Never an empty history: a read that cannot happen says so.
            throw new Error('the order database is not open');
          }
          return backend.all();
        },
        collectEmail: params.collectEmail,
        ...(params.customerRef === undefined ? {} : { customerRef: params.customerRef }),
        ...(followOnly === undefined ? {} : { followOnly }),
      });
      session = started;
      return startWithHint(
        () => started.start(),
        () => {
          // Only the loading line gains a hint: the session's first view replaces it.
          if (view === undefined && screen.kind === 'loading') {
            show({ kind: 'loading', slow: true });
          }
        },
      );
    },
    dropSession: () => {
      session?.dispose();
      session = undefined;
      view = undefined;
    },
  });
}

/** The content's own height (the body has no margin), never the frame's current one. */
function contentHeight(): number {
  return document.body.getBoundingClientRect().height;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
}

/** The frame's height, told smoothly: the loader sets each reported height at once. */
const heights = createHeightAnimator({
  post: (height) => handshake.post({ type: 'resize', height }),
  now: () => performance.now(),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  reducedMotion: prefersReducedMotion,
  innerWidth: () => window.innerWidth,
  innerHeight: () => window.innerHeight,
  setGrowing: (on) => document.documentElement.classList.toggle('growing', on),
});

// Registered synchronously, before anything renders: a hello is never missed.
const handshake = acceptHandshake(
  window as unknown as Parameters<typeof acceptHandshake>[0],
  (pageOrigin) => void start(pageOrigin),
  (reason) => show({ kind: 'refused', reason }),
);

if (params !== undefined) {
  document.documentElement.dataset.theme = params.theme;
  document.documentElement.dataset.display = params.display;
}
if (closeModal !== undefined) {
  closeOnEscape(window, closeModal);
}
draw();

// Tell the page how tall the content is.
if (root !== null && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => heights.target(contentHeight())).observe(document.body);
}
