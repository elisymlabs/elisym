import { type ReactNode, useState } from 'react';
import { errorMessage } from '../lib/errors';
import type { StoreForm } from '../lib/store-form';
import { Notice } from './Notice';
import { StoreFields } from './StoreFields';

interface Props {
  initial: StoreForm;
  submitLabel: string;
  /** Signs and posts; a thrown error is shown under the form. */
  onSubmit: (form: StoreForm) => Promise<string>;
  /** False while something must be settled first (shown in `children`). */
  canSubmit?: boolean;
  /** Shown just above the submit button. */
  children?: ReactNode;
}

export function StoreSettingsForm({
  initial,
  submitLabel,
  onSubmit,
  canSubmit = true,
  children,
}: Props) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      setDone(await onSubmit(form));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-24"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <StoreFields form={form} onChange={setForm} />
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {done === '' ? null : <Notice tone="success">{done}</Notice>}
      {children}
      {/* A solid bar that stays in reach at the bottom of the screen while the form scrolls. */}
      <div className="card sticky bottom-16 z-10 flex flex-wrap items-center justify-between gap-12 px-16 py-12 shadow-lg">
        <p className="text-13 text-text-2">
          Saving signs these settings with your secret key and replaces the previous ones.
        </p>
        <button type="submit" className="btn btn-primary" disabled={busy || !canSubmit}>
          {busy ? 'Signing...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
