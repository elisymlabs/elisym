import type { ComponentChildren } from 'preact';
import { type Countdown, type Rail, UNSURE_AFTER_SECS } from '../session';
import { secondsLeft, useNow } from './clock';
import { UNANSWERED, formatCountdown } from './text';

interface Props {
  chain: Rail;
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
export function UnansweredHint({ chain, startOverIn, unsureAt }: Props) {
  const now = useNow(true);
  const left = startOverIn === undefined ? undefined : secondsLeft(startOverIn, now);
  const unsure = isTakingLong(now, startOverIn, unsureAt);
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
        {UNANSWERED.lead} {UNANSWERED.countingLead}
        <span class="countdown">{formatCountdown(left)}</span>.
      </>
    );
    spoken = UNANSWERED.announce[chain];
  } else {
    line = UNANSWERED.checking[chain];
    spoken = UNANSWERED.checking[chain];
  }
  return (
    <>
      <p class="note hint">{line}</p>
      <p class="note hint">{UNANSWERED.reject}</p>
      <p class="visually-hidden" role="status" data-unanswered-status="">
        {spoken}
      </p>
    </>
  );
}

/** The hint's "taking long" rule, shared with the session's tests. */
export function isTakingLong(now: number, startOverIn?: Countdown, unsureAt?: number): boolean {
  if (startOverIn === undefined) {
    return unsureAt !== undefined && now >= unsureAt;
  }
  const reachedZeroAt = startOverIn.at + startOverIn.seconds;
  return now >= reachedZeroAt + UNSURE_AFTER_SECS;
}
