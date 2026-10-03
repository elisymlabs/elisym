import type { ComponentChildren } from 'preact';

interface Props {
  children: ComponentChildren;
  /** `h3` for a section inside the offer panel. */
  level?: 2 | 3;
}

/** The heading a step change caused by the buyer moves focus to: one in the card at a time. */
export function StepHeading({ children, level = 2 }: Props) {
  return level === 3 ? (
    <h3 class="step-heading" tabindex={-1} data-heading="">
      {children}
    </h3>
  ) : (
    <h2 class="step-heading" tabindex={-1} data-heading="">
      {children}
    </h2>
  );
}
