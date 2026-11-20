import { useState } from 'react';
import { contactEmailOf } from '../lib/contact';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';
import { TextField } from './TextField';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  onSaved: () => Promise<void>;
}

/** The owner's contact email: kept on the Askr server only, not signed or published. */
export function ContactEmailSection({ deps, view, onSaved }: Props) {
  const [typed, setTyped] = useState(view.email ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; text: string }>();
  const email = contactEmailOf(typed);
  const cleared = typed.trim() === '';
  const unchanged = (cleared ? null : email) === view.email;

  const save = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      await deps.api.setContactEmail(cleared ? null : (email ?? null));
      await onSaved();
      setStatus({
        tone: 'success',
        text: cleared ? 'Contact email removed.' : 'Contact email saved.',
      });
    } catch (failure) {
      setStatus({ tone: 'error', text: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Contact email"
      info={HELP.contactEmail}
      description="Where the Askr operator writes to you about your plan and account. Kept on the Askr server only, never published."
    >
      <TextField
        id="contact-email"
        label="Email"
        value={typed}
        placeholder="you@yourshop.com"
        hint={
          !cleared && email === undefined ? 'Enter an address like you@yourshop.com.' : undefined
        }
        onChange={(value) => {
          setTyped(value);
          setStatus(undefined);
        }}
      />
      {status === undefined ? null : <Notice tone={status.tone}>{status.text}</Notice>}
      <div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || unchanged || (!cleared && email === undefined)}
          onClick={() => void save()}
        >
          {busy ? 'Saving...' : 'Save email'}
        </button>
      </div>
    </Section>
  );
}
