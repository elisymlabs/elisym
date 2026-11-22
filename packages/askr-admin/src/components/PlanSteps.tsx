export type PlanStep = 1 | 2 | 3;

interface Props {
  /** The step the visitor is on. */
  current: PlanStep;
}

const STEPS: readonly { step: PlanStep; label: string }[] = [
  { step: 1, label: 'Save your key' },
  { step: 2, label: 'Pay' },
  { step: 3, label: 'Set up your store' },
];

/** Where a visitor who chose a plan on the landing is: save the key, pay, set up the store. */
export function PlanSteps({ current }: Props) {
  return (
    <ol id="plan-steps" aria-label="Steps" className="text-13 flex flex-wrap items-center gap-8">
      {STEPS.map(({ step, label }) => {
        const isCurrent = step === current;
        return (
          <li
            key={step}
            aria-current={isCurrent ? 'step' : undefined}
            className={`flex items-center gap-8 ${isCurrent ? 'text-text font-medium' : 'text-text-3'}`}
          >
            {step === 1 ? null : (
              <span aria-hidden="true" className="text-text-3">
                →
              </span>
            )}
            <span className="flex items-center gap-6">
              <span
                aria-hidden="true"
                className={`text-12 flex size-20 items-center justify-center rounded-full border ${
                  isCurrent ? 'bg-ink text-ink-text border-ink' : 'border-line-2'
                }`}
              >
                {step}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
