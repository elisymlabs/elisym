/** Design-only review of the real components. Canned data; no payments. */
import '../../src/app/styles.css';
import './review.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Checkout, type Actions } from '../../src/app/Checkout';
import { cannedSource, cannedViews, type CannedView } from './canned';

const PRIMARY_SCREENS = [
  ['Wallet confirmation', 'working'],
  ['Wallet not responding', 'signing: wallet unanswered, countdown'],
  ['Confirming payment', 'waiting for the payment'],
  ['Waiting for store', 'waiting for the store'],
  ['Payment complete', 'payment complete'],
  ['Purchases', 'your purchases: 3'],
  ['Purchase details', 'your purchases: detail delivered'],
] as const;
const extra = cannedViews()
  .filter((view) => !PRIMARY_SCREENS.some(([, name]) => name === view.name))
  .map((view) => [view.name, view.name] as const);
const SCREENS = [...PRIMARY_SCREENS, ...extra];
const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
document.documentElement.dataset.capture = String(capture);
document.documentElement.dataset.reviewFont =
  params.get('font') === 'system' ? 'system' : 'manrope';
document.documentElement.dataset.preview = 'true';
document.documentElement.dataset.display = 'modal';
function ReviewedCheckout({
  canned,
  actions,
  reset,
}: {
  canned: CannedView;
  actions: Actions;
  reset(): void;
}) {
  const [view, setView] = useState(canned.view);
  useEffect(() => {
    setView(canned.next ?? canned.view);
  }, [canned]);
  return (
    <Checkout
      screen={{ kind: 'loading' }}
      view={view}
      actions={actions}
      onClose={reset}
      {...canned.props}
      hintAfterMs={canned.props?.hintAfterMs ?? 3_600_000}
      unansweredHintMs={
        canned.props?.unansweredHintMs ?? (canned.name.includes('unanswered') ? 0 : 3_600_000)
      }
      purchases={canned.props?.purchases ?? cannedSource([])}
    />
  );
}
function Review() {
  const [screen, setScreen] = useState(Number(params.get('screen') ?? 0));
  const [theme, setTheme] = useState(params.get('theme') === 'dark' ? 'dark' : 'light');
  const run = useRef(0);
  document.documentElement.dataset.theme = theme;
  const canned = useMemo(() => {
    const views = cannedViews();
    return views.find((each) => each.name === SCREENS[screen]?.[1]) ?? views[0]!;
  }, [screen]);
  const reset = async () => setScreen(0);
  const actions: Actions = {
    choosePayout: () => {},
    setEmail: () => {},
    pay: reset,
    retry: reset,
    signAgain: reset,
    resend: reset,
    startOver: reset,
    cancel: () => setScreen(0),
    checkInWallet: reset,
    confirmOldPrompt: reset,
    cancelOldPrompt: () => {},
  };
  const play = async () => {
    const token = ++run.current;
    for (const step of [0, 2, 3, 4]) {
      if (run.current !== token) return;
      setScreen(step);
      await new Promise((resolve) => setTimeout(resolve, 2400));
    }
  };
  return (
    <>
      <nav class="review-controls" aria-label="Design preview">
        <span>Design preview · simulated states</span>
        <select
          aria-label="Screen"
          value={screen}
          onChange={(event) => {
            run.current++;
            setScreen(Number(event.currentTarget.value));
          }}
        >
          {SCREENS.map(([label], index) => (
            <option value={index} key={label}>
              {label}
            </option>
          ))}
        </select>
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
        <button onClick={() => void play()}>Play progress</button>
      </nav>
      <main class="review-window">
        <div class="review-chrome">
          <span aria-hidden="true">×</span>
        </div>
        <ReviewedCheckout
          key={[0, 1, 2, 3].includes(screen) ? 'progress' : screen}
          canned={canned}
          actions={actions}
          reset={() => setScreen(0)}
        />
      </main>
    </>
  );
}
render(<Review />, document.getElementById('app')!);
