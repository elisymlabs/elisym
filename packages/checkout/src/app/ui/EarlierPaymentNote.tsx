import type { EarlierPayment } from '../session';
import { secondsLeft, useNow } from './clock';
import { earlierPaymentLine, earlierPaymentStatus } from './text';

interface Props {
  problem: EarlierPayment;
  /** Fades in on its own: only outside a step that already does (never two at once). */
  reveal: boolean;
}

/**
 * The press asked the wallet nothing: the buyer's own earlier payment may still
 * land. A polite status that changes only with its phase; the countdown ticks
 * outside it.
 */
export function EarlierPaymentNote({ problem, reveal }: Props) {
  const countdown = problem.retryIn;
  const now = useNow(countdown !== undefined);
  const left = countdown === undefined ? undefined : secondsLeft(countdown, now);
  const line = earlierPaymentLine(problem, left);
  return (
    <div class={reveal ? 'problem reveal' : 'problem'} tabindex={-1} data-problem-note="">
      <p>
        {line.lead}
        {line.countdown === undefined ? null : <span class="countdown">{line.countdown}</span>}
        {line.tail}
      </p>
      <p class="visually-hidden" role="status" data-earlier-status="">
        {earlierPaymentStatus(problem)}
      </p>
    </div>
  );
}
