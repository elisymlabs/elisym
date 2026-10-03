import type { Problem, View } from '../session';
import { PayingLine } from './PayingLine';
import { ProblemNote } from './ProblemNote';
import { StepHeading } from './StepHeading';
import { Stepper } from './Stepper';
import { WORKING } from './text';
import { WalletRow } from './WalletRow';
import { Warnings } from './Warnings';

type ProgressView = Extract<View, { kind: 'working' | 'waiting_payment' | 'waiting_store' }>;

interface Props {
  view: ProgressView;
  problem: Problem | undefined;
  onConfirm(checked: boolean): void;
  onRetry(name: string): void;
  onStartOver(): void;
}

function activeStage(view: ProgressView): number {
  switch (view.kind) {
    case 'working':
      return view.step === 'signing' ? 1 : 0;
    case 'waiting_payment':
      return view.canRetry ? 1 : 2;
    case 'waiting_store':
      return 3;
  }
}

function heading(view: ProgressView): string {
  switch (view.kind) {
    case 'working':
      return 'Paying';
    case 'waiting_payment':
      return view.canRetry ? 'Payment not made' : 'Confirming payment';
    case 'waiting_store':
      return view.cancelled ? 'Order cancelled' : 'Paid';
  }
}

/** Working and waiting: where the purchase is, the exact payment, and what the buyer can do. */
export function ProgressStep({ view, problem, onConfirm, onRetry, onStartOver }: Props) {
  return (
    <div class="step" data-step="progress">
      <StepHeading>{heading(view)}</StepHeading>
      <PayingLine paying={view.paying} />
      <Stepper active={activeStage(view)} />
      {view.kind === 'working' ? (
        <p class="status" role="status">
          {WORKING[view.step]}
        </p>
      ) : null}
      {view.kind === 'waiting_payment' ? (
        <WaitingPayment
          view={view}
          problem={problem}
          onConfirm={onConfirm}
          onRetry={onRetry}
          onStartOver={onStartOver}
        />
      ) : null}
      {view.kind === 'waiting_store' ? <WaitingStore view={view} /> : null}
    </div>
  );
}

interface WaitingPaymentProps {
  view: Extract<View, { kind: 'waiting_payment' }>;
  problem: Problem | undefined;
  onConfirm(checked: boolean): void;
  onRetry(name: string): void;
  onStartOver(): void;
}

function WaitingPayment({ view, problem, onConfirm, onRetry, onStartOver }: WaitingPaymentProps) {
  const needsConfirm = view.canRetry && view.confirm.length > 0;
  return (
    <>
      <p class="status" role="status">
        {view.canRetry
          ? 'The payment did not go through. Nothing was paid.'
          : 'Waiting for the payment to confirm…'}
      </p>
      {view.tempo ? (
        <p class="note">
          If your wallet still shows the request, approve or reject it there. The widget keeps
          checking; there is no second payment from here.
        </p>
      ) : null}
      <ProblemNote problem={problem} asset={view.asset} />
      {view.explorer === undefined ? null : (
        <p>
          <a href={view.explorer} target="_blank" rel="noopener noreferrer">
            View the transaction
          </a>
        </p>
      )}
      {view.unsureLong ? (
        <p class="note">
          {view.tempo
            ? 'This is taking long. Check your wallet activity, or contact the store.'
            : 'This is taking long. If it does not resolve, contact the store.'}
        </p>
      ) : null}
      {needsConfirm ? (
        <Warnings
          warnings={view.confirm}
          confirm={{ checked: view.confirmed, onChange: onConfirm }}
        />
      ) : null}
      {view.canRetry ? (
        <>
          {view.wallets.length === 0 ? null : <p class="label">Try again with</p>}
          <div class="wallet-list">
            {view.wallets.map((wallet) => (
              <WalletRow
                key={wallet.name}
                wallet={wallet}
                tempo={false}
                disabled={needsConfirm && !view.confirmed}
                onPick={onRetry}
              />
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

interface WaitingStoreProps {
  view: Extract<View, { kind: 'waiting_store' }>;
}

function WaitingStore({ view }: WaitingStoreProps) {
  return (
    <>
      {view.cancelled ? (
        <p class="problem" role="alert">
          Paid, but the store cancelled this order. Contact the store.
        </p>
      ) : (
        <p class="status" role="status">
          Paid. Waiting for the store to deliver…
        </p>
      )}
      {view.noAnswer ? (
        <p class="note">The store has not answered for a while. Contact the store.</p>
      ) : null}
      {view.explorer === undefined ? null : (
        <p>
          <a href={view.explorer} target="_blank" rel="noopener noreferrer">
            View the payment
          </a>
        </p>
      )}
    </>
  );
}
