import type { ComponentChildren } from 'preact';
import type { Eip3009Wait, Problem, View } from '../session';
import { useNow } from './clock';
import { ProblemNote } from './ProblemNote';
import { EIP3009_WAIT, eip3009SendWords, formatCountdown } from './text';
import { WalletRow } from './WalletRow';

interface Props {
  view: Extract<View, { kind: 'waiting_payment' }>;
  wait: Eip3009Wait;
  problem: Problem | undefined;
  onRetry(name: string): void;
  onResend(): void;
  onStartOver(): void;
}

const UNSERVED =
  'This checkout cannot check this network. If the payment does not arrive, contact the store.';

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
  // The session draws no `switchAt` for an order whose nonce was used.
  const counting = wait.switchAt !== undefined && !view.canRetry && !wait.confirming;
  const now = useNow(counting || view.unsureAt !== undefined);
  if (wait.nonceUsed) {
    return (
      <>
        <p class="status" role="status">
          {EIP3009_WAIT.nonceUsed}
        </p>
        <p class="note">{EIP3009_WAIT.nonceUsedNote}</p>
        <ProblemNote problem={problem} asset={view.asset} rail="eip3009" canPress={false} />
      </>
    );
  }
  // Every word about the send comes from its state alone.
  const words = eip3009SendWords(wait.send);
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
      <p class="status" role="status">
        {status}
      </p>
      {switchNote === null ? null : <p class="note">{switchNote}</p>}
      <ProblemNote
        problem={problem}
        asset={view.asset}
        rail="eip3009"
        canPress={view.canRetry || wait.retry || wait.resend !== undefined}
      />
      {view.explorer === undefined || view.explorer === '' ? null : (
        <p>
          <a href={view.explorer} target="_blank" rel="noopener noreferrer">
            {words.link}
          </a>
        </p>
      )}
      {unsure ? <p class="note">{EIP3009_WAIT.takingLong}</p> : null}
      {wait.resend === undefined || view.canRetry || wait.confirming ? null : (
        <button type="button" class="primary" onClick={onResend}>
          {wait.resend === 'gas' ? EIP3009_WAIT.sendAnyway : EIP3009_WAIT.sendAgain}
        </button>
      )}
      {walletsShown ? (
        <>
          <p class="label">{view.canRetry ? EIP3009_WAIT.switchLabel : EIP3009_WAIT.retryLabel}</p>
          <div class="wallet-list">
            {view.wallets.map((wallet) => (
              <WalletRow key={wallet.name} wallet={wallet} disabled={false} onPick={onRetry} />
            ))}
          </div>
        </>
      ) : null}
      {view.canRetry ? (
        <button type="button" class="secondary" onClick={onStartOver}>
          Start over
        </button>
      ) : null}
    </>
  );
}
