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
    <ol class="stepper" style={{ '--progress': `${Math.min(active, 2) * 50}%` }}>
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
            <span class="step-marker" aria-hidden="true">{state === 'done' ? <><svg class="step-check-dark" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="m4 8 3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><svg class="step-check-light" width="21.6" height="21.6" viewBox="0 0 60 60" fill="none"><path d="M55 30C55 43.807 43.807 55 30 55C16.1929 55 5 43.807 5 30C5 16.1929 16.1929 5 30 5C43.807 5 55 16.1929 55 30Z" fill="var(--accent-fill)"/>
<path d="M40.0758 22.4242C40.808 23.1564 40.808 24.3436 40.0758 25.0757L27.5758 37.5757C26.8435 38.308 25.6565 38.308 24.9242 37.5757L19.9242 32.5757C19.192 31.8435 19.192 30.6565 19.9242 29.9242C20.6564 29.192 21.8436 29.192 22.5758 29.9242L26.25 33.5982L31.837 28.0112L37.4243 22.4242C38.1565 21.6919 39.3435 21.6919 40.0758 22.4242Z" fill="#1B1B1B"/></svg></> : null}</span>
            {stage}
            {suffix === undefined ? null : <span class="visually-hidden">{suffix}</span>}
          </li>
        );
      })}
    </ol>
  );
}
