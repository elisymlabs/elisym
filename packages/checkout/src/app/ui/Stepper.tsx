interface Props {
  /** The stage in progress (0 to 3); earlier ones are done. */
  active: number;
}

const STAGES = ['Order sent', 'Confirm in wallet', 'Payment confirmed', 'Complete'];

export function Stepper({ active }: Props) {
  return (
    <ol class="stepper">
      {STAGES.map((stage, index) => {
        let state = 'todo';
        if (index < active) {
          state = 'done';
        } else if (index === active) {
          state = 'active';
        }
        return (
          <li key={stage} data-state={state} aria-current={index === active ? 'step' : undefined}>
            {stage}
          </li>
        );
      })}
    </ol>
  );
}
