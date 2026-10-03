import type { ComponentChildren } from 'preact';

interface Props {
  children: ComponentChildren;
}

/** The heading a step change caused by the buyer moves focus to. */
export function StepHeading({ children }: Props) {
  return (
    <h2 class="step-heading" tabindex={-1} data-heading="">
      {children}
    </h2>
  );
}
