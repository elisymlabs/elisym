import type { ComponentChildren } from 'preact';
import { StepHeading } from './StepHeading';

interface Props {
  glyph: string;
  title: string;
  /** An alert (the buyer must act) rather than a plain outcome. */
  alert?: boolean;
  children: ComponentChildren;
  action?: { label: string; run(): void };
}

/** Refunded, cancelled, blocked or refused: what happened, and what is left to do. */
export function EndedStep({ glyph, title, alert = false, children, action }: Props) {
  return (
    <div class="step ended" data-step="ended">
      <img class="mark" src={glyph} alt="" aria-hidden="true" />
      <StepHeading>{title}</StepHeading>
      <div role={alert ? 'alert' : 'status'}>{children}</div>
      {action === undefined ? null : (
        <button type="button" class="primary" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
