import { type Ref, useImperativeHandle, useState } from 'react';
import { canRemember } from '../lib/remembered';

export type RememberChoice = { kind: 'off' } | { kind: 'on' };

export interface RememberHandle {
  /** Whether the merchant chose to remember the key on this device. */
  read: () => RememberChoice;
}

interface Props {
  ref: Ref<RememberHandle>;
  /** The checkbox text, e.g. "Remember my key on this device". */
  label: string;
  /** Prefix for the field ids, unique on the page. */
  id: string;
}

/** Remember the owner key on this device, on unless the merchant clears it. */
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
        you sign in with your owner key each time.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <label className="text-14 flex items-center gap-8">
        <input
          id={`${id}-remember`}
          type="checkbox"
          checked={on}
          onChange={(event) => setOn(event.target.checked)}
        />
        {label}
      </label>
      <p className="text-12 text-text-3 leading-relaxed">
        Kept sealed under a key this browser cannot export. Whoever uses this browser profile can
        sign in as you: leave it off on a shared computer.
      </p>
    </div>
  );
}
