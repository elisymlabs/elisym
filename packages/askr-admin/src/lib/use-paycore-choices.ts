import { useCallback, useEffect, useState } from 'react';
import type { SessionDeps } from './deps';
import { type PayCoreStoreView, readPayCoreStores } from './paycore';

/** The owner's PayCore stores as the form offers them (C7 discovery). */
export type PayCoreChoices =
  | { state: 'reading' }
  | { state: 'failed'; retry: () => void }
  | { state: 'read'; stores: PayCoreStoreView[] };

/** Read the signed-in owner's PayCore stores from the Askr relay, with a retry on failure. */
export function usePayCoreChoices(deps: Pick<SessionDeps, 'reader' | 'signer' | 'now'>) {
  const [choices, setChoices] = useState<PayCoreChoices>({ state: 'reading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  useEffect(() => {
    let current = true;
    const read = async () => {
      setChoices({ state: 'reading' });
      try {
        const stores = await readPayCoreStores(deps.reader, deps.signer.pubkey, deps.now());
        if (current) {
          setChoices({ state: 'read', stores });
        }
      } catch {
        if (current) {
          setChoices({ state: 'failed', retry });
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [deps, attempt, retry]);

  return choices;
}
