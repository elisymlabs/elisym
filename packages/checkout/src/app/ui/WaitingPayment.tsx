import type { ComponentChildren } from 'preact';
import type { Problem, View } from '../session';
import { secondsLeft, useNow } from './clock';
import { ProblemNote } from './ProblemNote';
import { AGAIN_DECLINED, formatCountdown } from './text';
import { WalletRow } from './WalletRow';

interface Props {
  view: Extract<View, { kind: 'waiting_payment' }>;
  problem: Problem | undefined;
  onRetry(name: string): void;
  onSignAgain(): void;
  onStartOver(): void;
}

const UNSERVED =
  'This checkout cannot check this network. If the payment does not arrive, contact the store.';
const RETRY_LATER =
  'A retry opens about two minutes after the attempt, once the network confirms it expired.';
const START_OVER_LATER =
  'Start over opens about two minutes after the attempt, once the network confirms it expired.';
const CHECKING_PAYMENT = 'Checking whether the payment went through…';
const CHECKING_REQUEST = 'Checking whether the request was approved…';
const NOT_SENT = 'The wallet’s answer was not sent.';

/**
 * The one status line of a Solana wait with nothing signed, first match wins,
 * and whether it already says what a wallet failure's note would.
 */
function unsignedStatus(
  view: Props['view'],
  problem: Problem | undefined,
  left: number | undefined,
): { status: string; saysProblem: boolean } {
  if (left === 0) {
    return { status: CHECKING_PAYMENT, saysProblem: false };
  }
  if (view.seenOnChain === true) {
    return {
      status: 'A transaction for this order reached the network. The checkout is confirming it.',
      saysProblem: false,
    };
  }
  if (view.expiring === true) {
    return { status: 'This request is about to expire.', saysProblem: false };
  }
  if (view.signedNotSent === true) {
    return { status: NOT_SENT, saysProblem: false };
  }
  if (problem?.reason === 'wallet_failed') {
    return {
      status: problem.declined === true ? AGAIN_DECLINED : 'The wallet did not answer.',
      saysProblem: true,
    };
  }
  if (problem?.reason === 'wallet_unsupported') {
    return { status: NOT_SENT, saysProblem: false };
  }
  // Nothing signed is stored, and nothing is sent before it is: true whatever the wallet did.
  if (problem?.reason === 'failed') {
    return { status: 'Something went wrong in the checkout. Nothing was sent.', saysProblem: true };
  }
  return { status: 'No signature reached this checkout.', saysProblem: false };
}

/**
 * A payment that may still land. Never a dead end: the buyer always sees what
 * to do or about how long to wait. The ticking number is not announced; only
 * the status line, whose text changes with the state, is.
 */
export function WaitingPayment({ view, problem, onRetry, onSignAgain, onStartOver }: Props) {
  const countdown = view.tempo ? view.requestEndsIn : view.retryIn;
  const ticking = countdown !== undefined || view.unsureAt !== undefined;
  const now = useNow(ticking);
  const left = countdown === undefined ? undefined : secondsLeft(countdown, now);
  const unsure = view.unsureAt !== undefined && now >= view.unsureAt;

  let status: string;
  let note: ComponentChildren = null;
  let unsureNote: string | undefined;
  // A request at 0 can only come back too close to its end: no button then.
  const againWallet =
    view.again !== undefined &&
    !view.canRetry &&
    !view.tempo &&
    !view.unserved &&
    (left === undefined || left > 0)
      ? view.again.wallet
      : undefined;
  let problemShown = problem;
  if (view.canRetry) {
    status = view.followOnly
      ? 'The payment did not go through. Nothing was paid. You can start over now.'
      : 'The payment did not go through. Nothing was paid. A retry is possible now.';
  } else if (view.unserved) {
    status = 'Waiting for the payment to confirm…';
    note = UNSERVED;
  } else if (view.tempo) {
    if (view.signed) {
      status = 'Your wallet sent the payment. The checkout is confirming it.';
    } else if (left === undefined) {
      status = 'Waiting for the payment to confirm…';
      note = 'Approve or reject the request in your wallet. The checkout keeps checking.';
    } else if (left > 0) {
      status = 'Waiting for the payment to confirm…';
      note = (
        <>
          The checkout stops waiting for this request in about{' '}
          <span class="countdown">{formatCountdown(left)}</span>. If you do not want to pay, reject
          it in your wallet.
        </>
      );
    } else {
      status = CHECKING_REQUEST;
    }
    // A request still counting down is not "taking long" yet.
    if (unsure && (left === undefined || left === 0)) {
      unsureNote = 'This is taking long. Check your wallet activity, or contact the store.';
    }
  } else {
    if (view.signed) {
      status = left === 0 ? CHECKING_PAYMENT : 'Waiting for the payment to confirm…';
    } else {
      const unsigned = unsignedStatus(view, problem, left);
      status = unsigned.status;
      if (unsigned.saysProblem) {
        problemShown = undefined;
      }
    }
    if (left !== 0) {
      if (view.followOnly) {
        note =
          left === undefined ? (
            START_OVER_LATER
          ) : (
            <>
              Start over opens in about <span class="countdown">{formatCountdown(left)}</span>.
            </>
          );
      } else if (left === undefined) {
        note = RETRY_LATER;
      } else if (againWallet !== undefined) {
        note = (
          <>
            Or try another wallet in about <span class="countdown">{formatCountdown(left)}</span>.
          </>
        );
      } else {
        const failed =
          problem?.reason === 'wallet_failed' || problem?.reason === 'wallet_unsupported';
        note =
          failed || !view.signed ? (
            <>
              You can retry in about <span class="countdown">{formatCountdown(left)}</span>.
            </>
          ) : (
            <>
              If it does not land, a retry opens in about{' '}
              <span class="countdown">{formatCountdown(left)}</span>.
            </>
          );
      }
    }
    if (unsure) {
      unsureNote = 'This is taking long. If it does not resolve, contact the store.';
    }
  }

  return (
    <>
      <p class="status" role="status">
        {status}
      </p>
      {note === null ? null : <p class="note">{note}</p>}
      <ProblemNote problem={problemShown} asset={view.asset} canPress={view.canRetry} />
      {view.explorer === undefined ? null : (
        <p>
          <a href={view.explorer} target="_blank" rel="noopener noreferrer">
            View the transaction
          </a>
        </p>
      )}
      {unsureNote === undefined ? null : <p class="note">{unsureNote}</p>}
      {againWallet === undefined ? null : (
        <button type="button" class="primary" onClick={onSignAgain}>
          Open {againWallet} again
        </button>
      )}
      {view.canRetry ? (
        <>
          {view.wallets.length === 0 ? null : <p class="label">Try again with</p>}
          <div class="wallet-list">
            {view.wallets.map((wallet) => (
              <WalletRow key={wallet.name} wallet={wallet} disabled={false} onPick={onRetry} />
            ))}
          </div>
          <button type="button" class="secondary" onClick={onStartOver}>
            Start over
          </button>
        </>
      ) : null}
    </>
  );
}
