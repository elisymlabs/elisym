/**
 * The create wizard's steps before a store exists (plan `admin-onboarding.md`
 * 2.2): a plan, an access key, then the terms and the signup. Which step is
 * current comes from the stage alone; a step past the stage cannot be opened.
 */

export type CreateStage = 'plan' | 'key' | 'signup';

export interface CreateStep {
  key: CreateStage;
  label: string;
  state: 'done' | 'current' | 'next';
  /** Cannot be opened at this stage. */
  locked: boolean;
}

const ORDER: readonly CreateStage[] = ['plan', 'key', 'signup'];

const LABELS: Record<CreateStage, string> = {
  plan: 'Plan',
  key: 'Access key',
  signup: 'Terms and payment',
};

/** The three steps at `stage`: those before it done, it current, those after it next and locked. */
export function createSteps(stage: CreateStage): CreateStep[] {
  const at = ORDER.indexOf(stage);
  return ORDER.map((key, index) => {
    let state: CreateStep['state'] = 'current';
    if (index < at) {
      state = 'done';
    } else if (index > at) {
      state = 'next';
    }
    return { key, label: LABELS[key], state, locked: index > at };
  });
}
