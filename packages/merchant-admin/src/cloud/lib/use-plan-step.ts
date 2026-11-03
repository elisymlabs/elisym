import { useCallback, useRef, useState } from 'react';

/**
 * One plan step at a time (Keep, Check again, Cancel, the change itself): a
 * second click while one runs is dropped. The step answers its refusal in
 * words, or '' when it went through.
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
    const refused = await step();
    inFlight.current = false;
    setBusy(false);
    setError(refused);
  }, []);
  return { busy, error, run };
}
