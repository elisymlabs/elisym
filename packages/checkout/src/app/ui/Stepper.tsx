import { STEPPER_STAGES } from './text';

interface Props {
  /**
   * The stage in progress (0 to 2); earlier ones are done. `STEPPER_STAGES.length`:
   * every stage is done, none current.
   */
  active: number;
}

type StageState = 'todo' | 'done' | 'active';

/** Said after a stage's name: its state is never told by color alone. */
const STATE_SUFFIXES: Partial<Record<StageState, string>> = { done: ', done', active: ', current' };

export function Stepper({ active }: Props) {
  return (
    <ol class="stepper">
      {STEPPER_STAGES.map((stage, index) => {
        let state: StageState = 'todo';
        if (index < active) {
          state = 'done';
        } else if (index === active) {
          state = 'active';
        }
        const suffix = STATE_SUFFIXES[state];
        return (
          <li key={stage} data-state={state} aria-current={index === active ? 'step' : undefined}>
            {stage}
            {suffix === undefined ? null : <span class="visually-hidden">{suffix}</span>}
          </li>
        );
      })}
    </ol>
  );
}
