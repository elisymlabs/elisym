import { useState } from 'react';
import { ApiError } from '../lib/api';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { Notice } from './Notice';

interface Props {
  deps: Pick<SessionDeps, 'api'>;
  /** Settings are stored: false only when none exist (not when they could not be read). */
  settingsSaved: boolean;
  /** Why the stored settings could not be read: shown instead of "Save your settings first". */
  configError: string;
  /** Read the store and its settings again: activation publishes the stored config (6.5). */
  onPlanChosen: () => Promise<void>;
}

const SAVE_FIRST = 'Save your settings first.';
const FREE_UNAVAILABLE = 'Free is not available right now. Message us with your Store ID.';
/** The store changed meanwhile (6.1): reading it again shows its new status. */
const CHANGED_MEANWHILE = new Set(['not_pending', 'operator_managed']);
const FREE_REFUSED = new Set(['capacity_reached', 'free_unavailable']);

/** Start on Free (6.5): the store goes live at once, once its settings are saved. */
export function StartFree({ deps, settingsSaved, configError, onPlanChosen }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const startFree = async () => {
    setBusy(true);
    setError('');
    try {
      await deps.api.choosePlan('free');
      await onPlanChosen();
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : undefined;
      if (code !== undefined && CHANGED_MEANWHILE.has(code)) {
        await onPlanChosen();
      } else if (code !== undefined && FREE_REFUSED.has(code)) {
        setError(FREE_UNAVAILABLE);
      } else if (code === 'no_settings') {
        setError(SAVE_FIRST);
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  let hint = '';
  if (!settingsSaved) {
    hint = configError === '' ? SAVE_FIRST : configError;
  }
  return (
    <>
      <button
        type="button"
        id="start-free"
        className="btn btn-primary w-full"
        disabled={busy || (!settingsSaved && configError === '')}
        aria-busy={busy}
        onClick={() => void startFree()}
      >
        Start on Free
      </button>
      {hint === '' ? null : <p className="text-13 text-text-2">{hint}</p>}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
    </>
  );
}
