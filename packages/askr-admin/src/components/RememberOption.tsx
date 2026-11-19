import { type Ref, useImperativeHandle, useState } from 'react';
import { HELP } from '../lib/help';
import { canRemember } from '../lib/remembered';
import { InfoTip } from './InfoTip';

export type RememberChoice = { kind: 'off' } | { kind: 'on' };

export interface RememberHandle {
  /** Whether the merchant chose to remember the key on this device. */
  read: () => RememberChoice;
}

interface Props {
  ref: Ref<RememberHandle>;
  /** The checkbox text, e.g. "Remember the new key on this device". */
  label: string;
  /** Prefix for the field ids, unique on the page. */
  id: string;
}

/** Remember a secret key on this device, on unless the merchant clears it. */
export function RememberOption({ ref, label, id }: Props) {
  const [available] = useState(canRemember);
  const [on, setOn] = useState(true);

  useImperativeHandle(
    ref,
    () => ({ read: () => (on && available ? { kind: 'on' } : { kind: 'off' }) }),
    [on, available],
  );

  if (!available) {
    return (
      <p className="text-13 text-text-2">
        This browser does not let the admin remember your key (a private window, for example), so
        you sign in with your secret key each time.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-6">
        <label className="text-14 flex items-center gap-8">
          <input
            id={`${id}-remember`}
            type="checkbox"
            checked={on}
            onChange={(event) => setOn(event.target.checked)}
          />
          {label}
        </label>
        <InfoTip help={HELP.rememberKey} about="Remembering the key" />
      </div>
      {on ? (
        <p className="text-12 text-text-3 pl-21">
          Kept encrypted in this browser and never sent anywhere. Anyone who can use this browser
          can sign in as your store, so clear this on a shared computer.
        </p>
      ) : null}
    </div>
  );
}
