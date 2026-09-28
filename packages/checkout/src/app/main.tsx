import './styles.css';
import { render } from 'preact';
import { OrderStore, openOrderDatabase } from '../core/order-store';
import { createRelayClient } from '../core/relay-client';
import { decodeCheckoutParams } from '../embed/protocol';
import { Checkout } from './Checkout';
import { type Screen, screenForPage } from './controller';
import { acceptHandshake } from './handshake';

const root = document.getElementById('app');
const params = decodeCheckoutParams(location.hash);
let screen: Screen = { kind: 'waiting' };

function show(next: Screen): void {
  screen = next;
  if (root !== null) {
    render(<Checkout screen={screen} />, root);
  }
}

async function openStore(): Promise<OrderStore | undefined> {
  try {
    return new OrderStore(await openOrderDatabase());
  } catch {
    return undefined;
  }
}

async function start(pageOrigin: string): Promise<void> {
  reportHeight();
  if (params === undefined) {
    show({ kind: 'refused', reason: 'no_product' });
    handshake.status('refused');
    return;
  }
  show({ kind: 'loading' });
  let next: Screen;
  try {
    next = await screenForPage(params, pageOrigin, {
      client: createRelayClient(),
      store: await openStore(),
    });
  } catch {
    // Storage or a relay failed in a way no check caught: never a Buy button then.
    next = { kind: 'refused', reason: 'failed' };
  }
  show(next);
  handshake.status(next.kind === 'offer' ? 'ready' : 'refused');
}

/** The content's own height (the body has no margin), never the frame's current one. */
function reportHeight(): void {
  handshake.post({ type: 'resize', height: document.body.getBoundingClientRect().height });
}

// Registered synchronously, before anything renders: a hello is never missed.
const handshake = acceptHandshake(
  window as unknown as Parameters<typeof acceptHandshake>[0],
  (pageOrigin) => void start(pageOrigin),
  (reason) => show({ kind: 'refused', reason }),
);

if (params !== undefined) {
  document.documentElement.dataset.theme = params.theme;
}
show(screen);

// Tell the page how tall the content is.
if (root !== null && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(reportHeight).observe(document.body);
}
