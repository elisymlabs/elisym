import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import type { ConsoleApi } from '../lib/api';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { PARTNER_INVITE_PREFIX } from '../lib/partner';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  onDone: () => void;
}

/** An invite from the operator binds this key as the store's owner. */
export function RedeemForm({ api, onDone }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Set before any await: a second click in the same moment sends nothing.
  const inFlight = useRef(false);

  const redeem = async () => {
    if (inFlight.current) {
      return;
    }
    const invite = input.current?.value.trim() ?? '';
    if (invite === '') {
      setError('Paste the invite you were sent.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    // A partner invite binds a partner key; any other is a store's.
    const answer = await api.request(
      'POST',
      invite.startsWith(PARTNER_INVITE_PREFIX) ? '/partner/redeem' : '/redeem',
      { invite },
    );
    if (answer.status === 200) {
      // Stays busy: the console reloads with the store.
      onDone();
      return;
    }
    inFlight.current = false;
    setBusy(false);
    setError(explain(fieldOf(answer.body, 'error'), answer.status));
  };

  return (
    <Card title="Redeem an invite">
      <p className="text-14 text-text-2 mt-8 leading-relaxed">
        Got an invite from elisym? It makes this key the owner of the store it was made for (or, for
        a partner invite, the key of your partner account).
      </p>
      <label htmlFor="invite" className="text-14 mt-16 block font-medium">
        Invite
      </label>
      <Input
        id="invite"
        ref={input}
        mono
        className="mt-8 w-full"
        type="text"
        autoComplete="off"
        spellCheck={false}
      />
      <p role="alert" className="text-13 text-error mt-8 empty:hidden">
        {error}
      </p>
      <Button
        disabled={busy}
        onClick={() => void redeem()}
        variant="primary"
        size="lg"
        full
        className="mt-16"
      >
        Redeem
      </Button>
    </Card>
  );
}
