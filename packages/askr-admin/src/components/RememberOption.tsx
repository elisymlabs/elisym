import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { MIN_PASSWORD_LENGTH, canRemember, passwordProblem } from '../lib/remembered';

export type RememberChoice =
  | { kind: 'off' }
  | { kind: 'invalid'; message: string }
  | { kind: 'on'; password: string };

export interface RememberHandle {
  /** What the merchant chose: off, a password, or why the password cannot be used. */
  read: () => RememberChoice;
}

interface Props {
  ref: Ref<RememberHandle>;
  /** The checkbox text, e.g. "Remember the new key on this device". */
  label: string;
  /** Prefix for the field ids, unique on the page. */
  id: string;
  /**
   * What a password manager files the password under: the Store ID when it is
   * known. Without it, a manager would take the secret key field above as the
   * user name and offer to save the key itself.
   */
  username: string;
}

/**
 * An opt-in to remember a secret key on this device, locked with a password.
 * The password fields are not React state: they are read when the key is
 * remembered, and cleared when the page is hidden, so the back/forward cache
 * keeps none.
 */
export function RememberOption({ ref, label, id, username }: Props) {
  const [available] = useState(canRemember);
  const [on, setOn] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const repeated = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const clear = () => {
      for (const field of [password.current, repeated.current]) {
        if (field !== null) {
          field.value = '';
        }
      }
    };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      read: () => {
        if (!on || !available) {
          return { kind: 'off' };
        }
        const first = password.current?.value ?? '';
        const second = repeated.current?.value ?? '';
        const problem = passwordProblem(first, second);
        if (problem !== undefined) {
          return { kind: 'invalid', message: problem };
        }
        return { kind: 'on', password: first };
      },
    }),
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
    <div className="flex flex-col gap-8">
      <label className="text-14 flex items-center gap-8">
        <input
          id={`${id}-remember`}
          type="checkbox"
          checked={on}
          onChange={(event) => setOn(event.target.checked)}
        />
        {label}
      </label>
      {on ? (
        <form className="flex flex-col gap-8" onSubmit={(event) => event.preventDefault()}>
          <input
            id={`${id}-username`}
            className="sr-only"
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
          <p className="text-13 text-text-2">
            Your key is kept on this device locked with a password you choose, and is never sent
            anywhere. Use this only on your own device. Whoever copies this browser's storage can
            try passwords offline, so a short or common one will not hold them off for long: a
            longer one does. The password cannot be reset: if you forget it, sign in with your
            secret key.
          </p>
          <label className="field" htmlFor={`${id}-password`}>
            <span className="field-label">
              Password (at least {MIN_PASSWORD_LENGTH} characters)
            </span>
            <input
              id={`${id}-password`}
              ref={password}
              className="input"
              type="password"
              autoComplete="new-password"
            />
          </label>
          <label className="field" htmlFor={`${id}-repeat`}>
            <span className="field-label">The same password again</span>
            <input
              id={`${id}-repeat`}
              ref={repeated}
              className="input"
              type="password"
              autoComplete="new-password"
            />
          </label>
        </form>
      ) : null}
    </div>
  );
}
