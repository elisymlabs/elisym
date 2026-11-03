/** Local interactive design preview. Never connects a wallet or sends a payment. */
import '../../src/app/styles.css';
import './buyer.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Checkout, type Actions } from '../../src/app/Checkout';
import { payoutPaying, type View } from '../../src/app/session';
import { aboutOf, cannedOffer, offerView, waitingView } from './canned';

const offer = cannedOffer({
  name: 'PayCore Design Lab',
  title: 'PayCore design test',
  summary: 'Test the checkout experience.',
  payouts: ['solana-mainnet'],
  level: 'C',
});
offer.offer.product.price.amount = '0.10';
for (const payout of offer.payouts) payout.amount = 100000n;
const about = aboutOf(offer);
const paying = payoutPaying(offer.payouts[0]!);

function Buyer() {
  const modal = useRef<HTMLDialogElement>(null);
  const attempt = useRef(0);
  const [view, setView] = useState<View>(offerView(offer));
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const reset = async () => {
    attempt.current++;
    setView(offerView(offer));
  };
  const close = () => {
    attempt.current++;
    modal.current?.close();
  };
  const pay = async () => {
    const current = ++attempt.current;
    const pause = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return current === attempt.current;
    };
    setView({ kind: 'working', step: 'checking', paying, about, cancellable: true });
    if (!(await pause(1000))) return;
    setView({ kind: 'working', step: 'signing', paying, about });
    if (!(await pause(1500))) return;
    setView(waitingView(about, paying));
    if (!(await pause(1800))) return;
    setView({ kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false });
    if (!(await pause(900))) return;
    setView({
      kind: 'delivered',
      store: about.store,
      product: about.product,
      receipt: {
        store: 'PayCore Design Lab',
        product: about.product.title,
        paying,
        orderId: 'design-preview',
        paid: { tx: 'Demo payment — no transaction sent', at: Math.floor(Date.now() / 1000) },
        answeredAt: Math.floor(Date.now() / 1000),
      },
    });
  };
  const actions: Actions = {
    choosePayout: (index) => setView(offerView(offer, { payoutIndex: index })),
    setEmail: (email) =>
      setView((previous) => (previous.kind === 'offer' ? { ...previous, email } : previous)),
    pay,
    retry: pay,
    signAgain: pay,
    resend: pay,
    checkInWallet: pay,
    startOver: reset,
    cancel: () => {
      void reset();
    },
    confirmOldPrompt: pay,
    cancelOldPrompt: () => {
      void reset();
    },
  };
  return (
    <>
      <header class="shop-header">
        <strong>PayCore Design Lab</strong>
        <button class="secondary" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
      </header>
      <main class="shop-main">
        <p class="shop-label">CHECKOUT PREVIEW</p>
        <h1>PayCore design test</h1>
        <p>Пройдите покупку так, как её видит пользователь.</p>
        <p class="shop-price">
          0.10 <small>USDC</small>
        </p>
        <button
          class="primary"
          onClick={() => {
            void reset();
            modal.current?.showModal();
          }}
        >
          Buy with PayCore
        </button>
        <p class="shop-demo">Демо: кошелёк и оплата имитируются. Деньги не списываются.</p>
      </main>
      <dialog
        ref={modal}
        class="buyer-dialog"
        onCancel={close}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        aria-label="PayCore checkout"
      >
        <div class="buyer-content">
          <div class="buyer-top">
            <span>Demo · no real payment</span>
            <button class="secondary" aria-label="Close checkout" onClick={close}>
              ×
            </button>
          </div>
          <Checkout screen={{ kind: 'loading' }} view={view} actions={actions} onClose={close} />
        </div>
      </dialog>
    </>
  );
}
render(<Buyer />, document.getElementById('app')!);
