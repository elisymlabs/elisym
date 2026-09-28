import type { OfferWarning } from '@elisym/commerce';
import { type Asset, NATIVE_SOL, formatAssetAmount } from '@elisym/pay-core';
import type { RefusalReason, Screen } from './controller';
import type { Problem, View } from './session';

export interface Actions {
  confirm(checked: boolean): void;
  setEmail(value: string): void;
  pay(walletName: string): void;
  retry(walletName: string): void;
  startOver(): void;
}

interface Props {
  /** Before the purchase session starts: waiting, loading or refused. */
  screen: Screen;
  /** The purchase, once the offer is loaded. */
  view?: View;
  actions: Actions;
}

const REFUSALS: Record<RefusalReason, string> = {
  not_framed: 'This checkout only works embedded in a store page.',
  no_hello: 'The store page did not start the checkout.',
  no_product: 'This checkout names no product.',
  no_storage:
    'This browser blocks storage for the checkout (private mode?). Payments need it to stay safe.',
  offer_refused: 'This product cannot be bought here.',
  failed: 'The checkout could not start. Reload the page to try again.',
};

const WARNINGS: Record<OfferWarning, string> = {
  domain_unverified: 'The store names a domain that does not confirm it.',
  origin_mismatch: 'This page is not on the store’s domain.',
  origin_unverifiable: 'No domain vouches for this store: check you trust this page.',
  payout_recently_changed: 'The store changed where it is paid very recently.',
  payout_changed: 'The store is paid to a different address than on your last purchase.',
  payout_unsigned: 'The payout address carries no wallet proof.',
  owner_unpinned: 'First purchase from this store on this site.',
};

const WORKING: Record<Extract<View, { kind: 'working' }>['step'], string> = {
  checking: 'Checking…',
  ordering: 'Sending the order to the store…',
  signing: 'Confirm the payment in your wallet…',
};

/** `asset`: the coin the order is paid in, for amounts of it. */
function problemText(problem: Problem, asset: Asset): string {
  switch (problem.reason) {
    case 'no_wallet':
      return 'Connect a Solana wallet that can sign transactions (Phantom, Solflare, MetaMask).';
    case 'clock_skew':
      return 'This device’s clock is more than 5 minutes off. Fix the clock and try again.';
    case 'rpc_error':
      return 'The Solana network could not be reached. Try again in a moment.';
    case 'self_payment':
      return 'This wallet is the store’s own payout address; pay from another wallet.';
    case 'too_late':
      return 'This order is too old to pay. Start a new one.';
    case 'order_not_acknowledged':
      return 'The store’s relays did not take the order yet. Try again.';
    case 'no_store_inbox':
      return 'The store names no inbox to send orders to. Contact the store.';
    case 'failed':
      return 'Something went wrong. Try again.';
    case 'wallet_failed':
      return 'The wallet did not sign. If it did after all, the payment is found; otherwise you can retry in about a minute and a half.';
    case 'wallet_unsupported':
      return 'This wallet changed the transaction, which the checkout never sends. You can retry in about a minute and a half, or use another wallet.';
    case 'offer_changed':
      return 'The store changed this offer. Review it before paying.';
    case 'offer_refused':
      return 'The store no longer offers this product here. Your order is still being followed.';
    case 'confirm_first':
      return 'Read the warnings and tick the box before paying.';
    case 'bad_email':
      return 'That email does not look right. Fix it, or leave the field empty.';
    case 'insufficient_token':
      return `Not enough funds: the price is ${formatAssetAmount(asset, problem.needed)}, the wallet holds ${formatAssetAmount(asset, problem.available)}.`;
    case 'insufficient_sol':
      return `Not enough SOL for the network fees: ${formatAssetAmount(NATIVE_SOL, problem.needed)} needed, ${formatAssetAmount(NATIVE_SOL, problem.available)} held.`;
  }
}

function ProblemNote({ problem, asset }: { problem: Problem | undefined; asset: Asset }) {
  return problem === undefined ? null : (
    <p class="problem" role="alert">
      {problemText(problem, asset)}
    </p>
  );
}

/** Store data is rendered as text only; a delivery is a link only when it is `https:`. */
export function Checkout({ screen, view, actions }: Props) {
  if (view === undefined) {
    if (screen.kind === 'refused') {
      return (
        <div class="refused" role="alert">
          <p>{REFUSALS[screen.reason]}</p>
          {screen.message === undefined ? null : <p class="muted">{screen.message}</p>}
        </div>
      );
    }
    return <p class="muted">Loading…</p>;
  }
  switch (view.kind) {
    case 'offer': {
      const { product } = view.offer.offer;
      const warnings = [...view.confirm, ...view.notices];
      const canPay = view.confirmed && view.wallets.length > 0;
      return (
        <article>
          <h1>{product.title}</h1>
          {product.summary === undefined ? null : <p>{product.summary}</p>}
          <p class="price">
            {product.price.amount} {product.price.currency}
          </p>
          <p class="muted">
            Sold by {view.offer.offer.profile.name ?? 'an unnamed store'}
            {view.offer.offer.domain === undefined ? '' : ` (${view.offer.offer.domain})`}, trust
            level {view.offer.offer.level}. Paid in {view.payout.target.caip19.asset.symbol} on
            Solana {view.payout.target.caip19.chain.network}.
          </p>
          {warnings.length === 0 ? null : (
            <ul class="warnings">
              {warnings.map((warning) => (
                <li key={warning}>{WARNINGS[warning]}</li>
              ))}
            </ul>
          )}
          {view.confirm.length === 0 ? null : (
            <label class="confirm">
              <input
                type="checkbox"
                checked={view.confirmed}
                onChange={(event) => actions.confirm(event.currentTarget.checked)}
              />{' '}
              I have read the warnings above and still want to pay.
            </label>
          )}
          {view.askEmail ? (
            <label class="email">
              Email for the delivery (optional)
              <input
                type="email"
                autoComplete="email"
                value={view.email}
                onInput={(event) => actions.setEmail(event.currentTarget.value)}
              />
            </label>
          ) : null}
          <ProblemNote problem={view.problem} asset={view.payout.target.caip19.asset} />
          {view.continuing ? <p class="muted">Your earlier order is still open.</p> : null}
          {view.wallets.length === 0 ? (
            <p class="muted">No Solana wallet found in this browser.</p>
          ) : (
            <div class="wallets">
              {view.wallets.map((wallet) => (
                <button
                  type="button"
                  key={wallet.name}
                  disabled={!canPay}
                  onClick={() => actions.pay(wallet.name)}
                >
                  Pay with {wallet.name}
                </button>
              ))}
            </div>
          )}
        </article>
      );
    }
    case 'working':
      return <p class="muted">{WORKING[view.step]}</p>;
    case 'waiting_payment':
      return (
        <div>
          <p>
            {view.canRetry
              ? 'The payment did not go through. Nothing was paid.'
              : 'Waiting for the payment to confirm…'}
          </p>
          {view.problem === undefined ? null : (
            <p class="problem" role="alert">
              {problemText(view.problem, view.asset)}
            </p>
          )}
          {view.explorer === undefined ? null : (
            <p>
              <a href={view.explorer} target="_blank" rel="noopener noreferrer">
                View the transaction
              </a>
            </p>
          )}
          {view.unsureLong ? (
            <p class="muted">This is taking long. If it does not resolve, contact the store.</p>
          ) : null}
          {view.canRetry && view.confirm.length > 0 ? (
            <>
              <ul class="warnings">
                {view.confirm.map((warning) => (
                  <li key={warning}>{WARNINGS[warning]}</li>
                ))}
              </ul>
              <label class="confirm">
                <input
                  type="checkbox"
                  checked={view.confirmed}
                  onChange={(event) => actions.confirm(event.currentTarget.checked)}
                />{' '}
                I have read the warnings above and still want to pay.
              </label>
            </>
          ) : null}
          {view.canRetry ? (
            <div class="wallets">
              {view.wallets.map((wallet) => (
                <button type="button" key={wallet.name} onClick={() => actions.retry(wallet.name)}>
                  Try again with {wallet.name}
                </button>
              ))}
              <button type="button" class="secondary" onClick={() => actions.startOver()}>
                Start over
              </button>
            </div>
          ) : null}
        </div>
      );
    case 'waiting_store':
      return (
        <div>
          <p>
            {view.cancelled
              ? 'Paid, but the store cancelled this order. Contact the store.'
              : 'Paid. Waiting for the store to deliver…'}
          </p>
          {view.explorer === undefined ? null : (
            <p>
              <a href={view.explorer} target="_blank" rel="noopener noreferrer">
                View the payment
              </a>
            </p>
          )}
        </div>
      );
    case 'delivered':
      return (
        <div>
          <p class="done">Delivered.</p>
          {view.link === undefined ? (
            <p class="delivery">{view.text}</p>
          ) : (
            <p>
              <a href={view.link} target="_blank" rel="noopener noreferrer">
                {view.link}
              </a>
            </p>
          )}
          <div class="wallets">
            <button type="button" class="secondary" onClick={() => actions.startOver()}>
              Buy again
            </button>
          </div>
        </div>
      );
    case 'refunded':
      return (
        <div>
          <p>The store cancelled this order and refunded the payment.</p>
          <div class="wallets">
            <button type="button" onClick={() => actions.startOver()}>
              Start a new order
            </button>
          </div>
        </div>
      );
    case 'cancelled':
      return (
        <div>
          <p>The store cancelled this order. Nothing was paid.</p>
          <div class="wallets">
            <button type="button" onClick={() => actions.startOver()}>
              Start a new order
            </button>
          </div>
        </div>
      );
    case 'refused':
      return (
        <div class="refused" role="alert">
          <p>{REFUSALS.offer_refused}</p>
          <p class="muted">{view.message}</p>
        </div>
      );
  }
}
