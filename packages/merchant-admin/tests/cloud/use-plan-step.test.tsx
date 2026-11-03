import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { STEP_FAILED, usePlanStep } from '../../src/cloud/lib/use-plan-step';
import { type Mounted, buttonNamed, mount, settle } from '../mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** A button running `step` through the hook, its busy flag and its words shown. */
function Stepper({ step }: { step: () => Promise<string> }) {
  const { busy, error, run } = usePlanStep();
  return (
    <div>
      <button type="button" disabled={busy} onClick={() => void run(step)}>
        Go
      </button>
      <p role="alert">{error}</p>
    </div>
  );
}

function shown(): string {
  return document.querySelector('[role="alert"]')?.textContent ?? '';
}

describe('a plan step', () => {
  it('a step that throws frees the button and says so, and the next click runs', async () => {
    let calls = 0;
    const step = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('the signer refused');
      }
      return '';
    };
    mounted = await mount(<Stepper step={step} />);
    const button = buttonNamed(mounted.container, 'Go');
    await act(async () => button.click());
    await settle(() => shown() === STEP_FAILED);
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await settle(() => calls === 2 && shown() === '');
    expect(calls).toBe(2);
    expect(shown()).toBe('');
  });

  it("a step's refusal is shown as its words", async () => {
    mounted = await mount(<Stepper step={async () => 'Keep Business first.'} />);
    await act(async () => buttonNamed(mounted?.container ?? document.body, 'Go').click());
    await settle(() => shown() === 'Keep Business first.');
    expect(shown()).toBe('Keep Business first.');
  });
});
