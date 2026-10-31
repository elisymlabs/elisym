interface Step {
  key: string;
  label: string;
  state: 'done' | 'current' | 'next';
  /** Cannot be opened yet. */
  locked?: boolean;
}

/** The step badge's look, by state. */
const BADGES: Record<Step['state'], string> = {
  done: 'bg-accent-soft text-accent-ink',
  current: 'bg-accent text-accent-text',
  next: 'bg-surface-2',
};

interface Props {
  steps: readonly Step[];
  /** Opens a step that is not locked; none: the list only shows. */
  onSelect?: (key: string) => void;
  /** The step shown now, when it is not the current one. */
  selected?: string;
}

/** Where the merchant is in setting up the store: each step done, current or still to come. */
export function Stepper({ steps, onSelect, selected }: Props) {
  return (
    <ol aria-label="Store setup" className="flex flex-col gap-4">
      {steps.map((step, index) => (
        <li
          key={step.key}
          data-step={step.key}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`text-14 flex items-center gap-10 ${step.state === 'next' ? 'text-text-3' : ''}`}
        >
          <span
            aria-hidden="true"
            className={`rounded-6 text-12 grid size-24 shrink-0 place-items-center font-semibold ${BADGES[step.state]}`}
          >
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          {onSelect !== undefined && step.locked !== true ? (
            <button
              type="button"
              onClick={() => onSelect(step.key)}
              aria-current={selected === step.key ? 'true' : undefined}
              className={`text-left underline-offset-4 hover:underline ${
                step.state === 'current' || selected === step.key ? 'font-semibold' : ''
              }`}
            >
              {step.label}
              {step.state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </button>
          ) : (
            <span className={step.state === 'current' ? 'font-semibold' : ''}>
              {step.label}
              {step.state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
