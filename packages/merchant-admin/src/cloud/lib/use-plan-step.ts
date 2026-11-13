import { useCallback, useRef, useState } from 'react';

export const STEP_FAILED = 'That did not go through: check your connection and try again.';

/**
 * One plan step at a time (Keep, Check again, Cancel, the change itself): a
 * second click while one runs is dropped. The step answers its refusal in
 * words, or '' when it went through. A step that throws (a signer that
 * refuses, a store read that fails) frees the buttons and says so.
 */
export function usePlanStep() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const run = useCallback(async (step: () => Promise<string>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    let refused = STEP_FAILED;
    try {
      refused = await step();
    } catch {
      refused = STEP_FAILED;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setError(refused);
    }
  }, []);
  return { busy, error, run };
}
