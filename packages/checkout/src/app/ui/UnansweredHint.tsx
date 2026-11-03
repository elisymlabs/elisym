import type { ComponentChildren } from 'preact';
import { type Countdown, type Rail, UNSURE_AFTER_SECS } from '../session';
import { secondsLeft, useNow } from './clock';
import { UNANSWERED, formatCountdown } from './text';

interface Props {
  chain: Rail;
  compact?: boolean;
  /** About when the request can be judged over (Start over then). */
  startOverIn?: Countdown;
  /** With no countdown: after this (unix seconds), it is taking long. */
  unsureAt?: number;
}

/**
 * The wallet has not answered a payment request: when Start over opens, then
 * that the checkout is checking, then that it is taking long. A running
 * countdown is never "taking long"; one that reached 0 says "checking" until it
 * has stayed unresolved `UNSURE_AFTER_SECS` past 0 (the probe normally settles
 * the attempt within a few seconds). Without a countdown, "taking long" starts
 * at `unsureAt`. The ticking number is not announced: the live region speaks
 * once per phase.
 */
export function UnansweredHint({ chain, startOverIn, unsureAt, compact = false }: Props) {
  const now = useNow(true);
  const left = startOverIn === undefined ? undefined : secondsLeft(startOverIn, now);
  const unsure = isTakingLong(now, startOverIn, unsureAt, chain);
  let line: ComponentChildren;
  let spoken: string;
  if (unsure) {
    line = UNANSWERED.takingLong;
    spoken = UNANSWERED.takingLong;
  } else if (left === undefined) {
    line = `${UNANSWERED.lead} ${UNANSWERED.unknown[chain]}`;
    spoken = UNANSWERED.announce[chain];
  } else if (left > 0) {
    line = (
      <>
        {UNANSWERED.lead} {UNANSWERED.countingLead[chain]}
        <span class="countdown">{formatCountdown(left)}</span>.
      </>
    );
    spoken = UNANSWERED.announce[chain];
  } else {
    line = UNANSWERED.checking[chain];
    spoken = UNANSWERED.checking[chain];
  }
  const options = (
    <>
      <p class="note hint">{line}</p>
      <p class="note hint">{UNANSWERED.reject}</p>
    </>
  );
  return (
    <>
      {compact ? (
        <div class="wallet-help">
          <p class="wallet-wait-summary">
            {unsure
              ? 'Taking longer than expected'
              : left === 0
                ? 'Checking the request status…'
                : 'Your wallet hasn’t responded yet'}
          </p>
          <details class="wallet-wait-options">
            <summary>Options<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></summary>
            <div class="wallet-options-content">
              <p class="note hint wallet-options-timing">
                {unsure ? 'If this does not resolve, contact the store' : left === undefined ? UNANSWERED.unknown[chain] : left > 0 ? <>{UNANSWERED.countingLead[chain]}<span class="countdown">{formatCountdown(left)}</span></> : UNANSWERED.checking[chain]}
              </p>
              <p class="note hint">To cancel, reject the request in your wallet</p>
            </div>
          </details>
        </div>
      ) : (
        options
      )}
      <p class="visually-hidden" role="status" data-unanswered-status="">
        {spoken}
      </p>
    </>
  );
}

/**
 * The hint's "taking long" rule, shared with the session's tests. On EIP-3009
 * it is the session's own moment (`unsureAt`, from the chain's waits), never
 * the countdown's zero plus `UNSURE_AFTER_SECS`.
 */
export function isTakingLong(
  now: number,
  startOverIn?: Countdown,
  unsureAt?: number,
  rail?: Rail,
): boolean {
  if (startOverIn === undefined || rail === 'eip3009') {
    return unsureAt !== undefined && now >= unsureAt;
  }
  const reachedZeroAt = startOverIn.at + startOverIn.seconds;
  return now >= reachedZeroAt + UNSURE_AFTER_SECS;
}
