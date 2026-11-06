import type { ComponentChildren } from 'preact';
import type { Eip3009Wait, Problem, View } from '../session';
import { useNow } from './clock';
import { ProblemNote } from './ProblemNote';
import { EIP3009_WAIT, eip3009SendWords, formatCountdown, statusSubtitle } from './text';
import { WalletPicker } from './WalletPicker';

interface Props {
  view: Extract<View, { kind: 'waiting_payment' }>;
  wait: Eip3009Wait;
  problem: Problem | undefined;
  onRetry(name: string): void;
  onResend(): void;
  onStartOver(): void;
}

const UNSERVED = 'If the payment does not appear, contact the store.';

/**
 * An EIP-3009 payment that may still land (Ethereum, Arbitrum, Base). Not the
 * single countdown of the other rails: the same wallet may pay again at once
 * (its two signatures exclude each other), another wallet and Start over only
 * once the signature provably expired unused (`canRetry`), counted down to
 * `switchAt`. "Confirming" says the chain's own wait. An order whose nonce was
 * used outside this checkout shows its line only: no timer, no other wallet,
 * no end. A page that only follows the order offers no wallet: its countdown
 * and its over line name Start over alone.
 */
export function Eip3009Waiting({ view, wait, problem, onRetry, onResend, onStartOver }: Props) {
  // Every word about the send comes from its state alone.
  const words = eip3009SendWords(wait.send);
  // Another wallet's countdown is shown only while the page does not say the
  // payment is confirming (sent, linked or maybe sent): never while it may be
  // on its way (a 45-minute timer then reads as a block). A page that only follows the order counts down to
  // Start over, its one action. The session draws no `switchAt` for an order whose nonce was
  // used.
  const counting =
    wait.switchAt !== undefined &&
    !view.canRetry &&
    !wait.confirming &&
    (view.followOnly || !words.confirming);
  const now = useNow(counting || view.unsureAt !== undefined);
  if (wait.nonceUsed) {
    return (
      <>
        <div class="payment-wait-note eip3009-wait-note">
          <p class="status eip3009-note-heading" role="status">{statusSubtitle(EIP3009_WAIT.nonceUsed)}</p>
          <p class="note">{EIP3009_WAIT.nonceUsedNote}</p>
          <ProblemNote detailOnly problem={problem} asset={view.asset} rail="eip3009" canPress={false} />
        </div>
      </>
    );
  }
  const confirmingLine = EIP3009_WAIT.confirming(wait.chain, wait.creditSecs);
  let status: string;
  if (view.canRetry) {
    // A page that only follows the order offers no wallet: Start over only.
    status = view.followOnly ? EIP3009_WAIT.overFollowOnly : EIP3009_WAIT.over;
  } else if (wait.confirming) {
    status = confirmingLine;
  } else {
    status = words.confirming ? `${words.lead} ${confirmingLine}` : words.lead;
  }
  let switchNote: ComponentChildren = null;
  if (view.unserved) {
    switchNote = UNSERVED;
  } else if (counting && wait.switchAt !== undefined) {
    const left = wait.switchAt - now;
    switchNote =
      left > 0 ? (
        <>
          {view.followOnly ? EIP3009_WAIT.startOverLead : EIP3009_WAIT.switchLead}
          <span class="countdown">{formatCountdown(left)}</span>
          {view.followOnly ? EIP3009_WAIT.startOverTail : EIP3009_WAIT.switchTail}
        </>
      ) : (
        EIP3009_WAIT.switchChecking
      );
  }
  const unsure = !view.canRetry && view.unsureAt !== undefined && now >= view.unsureAt;
  const walletsShown = (wait.retry || view.canRetry) && view.wallets.length > 0;
  return (
    <>
      <div class="eip3009-status-group">
        {view.unserved ? (
          <div class="payment-wait-note eip3009-wait-note" data-unserved="true">
            <p class="status" role="status">{statusSubtitle('This checkout can’t check this network.')}</p>
            <p class="note">{statusSubtitle(UNSERVED)}</p>
          </div>
        ) : (
          <div class="payment-wait-note eip3009-wait-note">
            <p class="status" role="status">{statusSubtitle(status)}</p>
            {switchNote === null ? null : <p class="note">{switchNote}</p>}
            <ProblemNote
              detailOnly
              problem={problem}
              asset={view.asset}
              rail="eip3009"
              canPress={view.canRetry || wait.retry || wait.resend !== undefined}
            />
            {unsure ? <p class="note taking-long-note">{EIP3009_WAIT.takingLong}</p> : null}
            {wait.resend === undefined || view.canRetry || wait.confirming ? null : (
              <button type="button" class="secondary resend-action" onClick={onResend}>
                {wait.resend === 'gas' ? EIP3009_WAIT.sendPayment : EIP3009_WAIT.sendAgain}
              </button>
            )}
          </div>
        )}
        {view.explorer === undefined || view.explorer === '' ? null : (
          <a class="secondary transaction-action" href={view.explorer} target="_blank" rel="noopener noreferrer">
            {words.link} <span aria-hidden="true">↗</span>
          </a>
        )}
        {view.canRetry ? (
          <button type="button" class="secondary" onClick={onStartOver}>
            {EIP3009_WAIT.startNewOrder}
          </button>
        ) : null}
      </div>
      {walletsShown ? (
        <div class="eip3009-retry-group">
          <WalletPicker
            wallets={view.wallets}
            disabled={false}
            label={view.canRetry ? EIP3009_WAIT.switchLabel : EIP3009_WAIT.retryLabel}
            actionLabel={view.canRetry ? EIP3009_WAIT.payAgain : EIP3009_WAIT.signAgain}
            retryFlow
            secondaryAction={wait.resend !== undefined && !view.canRetry}
            onPay={onRetry}
          />
        </div>
      ) : null}
    </>
  );
}
