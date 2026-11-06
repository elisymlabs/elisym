import { ErrorIcon } from './ErrorIcon';
import { RETURN_GLYPH, SOLD_OUT_GLYPH } from './glyphs';
import type { ComponentChildren } from 'preact';
import { StepHeading } from './StepHeading';

interface Props {
  glyph: string;
  title: string;
  /** An alert (the buyer must act) rather than a plain outcome. */
  alert?: boolean;
  children: ComponentChildren;
  /** Shown last, after the action and outside the outcome's live region (a receipt). */
  after?: ComponentChildren;
  action?: { label: string; run(): void };
}

/** Refunded, cancelled, blocked or refused: what happened, and what is left to do. */
export function EndedStep({ glyph, title, alert = false, children, after, action }: Props) {
  const markPath = glyph === SOLD_OUT_GLYPH
    ? 'M7.5 12h9'
    : 'M10 8 7 11l3 3M7 11h6a3 3 0 0 1 0 6h-2';
  return (
    <div class="step ended" data-step="ended">
      {glyph !== SOLD_OUT_GLYPH && glyph !== RETURN_GLYPH ? (
        <ErrorIcon class="mark outcome-icon" />
      ) : <svg class="mark outcome-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="currentColor" />
        <path
          d={markPath}
          transform={glyph === RETURN_GLYPH ? 'translate(4.525 3.875) scale(.65)' : undefined}
          stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>}
      <StepHeading>{title}</StepHeading>
      <div class="outcome-description" role={alert ? 'alert' : 'status'}>{children}</div>
      {action === undefined ? null : (
        <button type="button" class="primary" onClick={action.run}>
          {action.label}
        </button>
      )}
      {after}
    </div>
  );
}
