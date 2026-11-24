import { useEffect, useState } from 'react';
import type { HostedConfig } from '../lib/hosted-config';
import { type SessionApi, type SessionLoad, loadSession } from '../lib/session';
import { BUTTON_SECONDARY } from '../styles';
import { ForgetOnDevice } from './ForgetOnDevice';
import { SessionMessage } from './SessionMessage';
import { StoreShell } from './StoreShell';

interface Props {
  api: SessionApi;
  config: HostedConfig;
  /** O, hex. */
  owner: string;
  onSignOut: () => void;
}

/** A signed-in owner: the server checked against the committed config, then their store. */
export function Session({ api, config, owner, onSignOut }: Props) {
  const [load, setLoad] = useState<SessionLoad | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoad(undefined);
    void loadSession(api, config).then((outcome) => {
      if (current) {
        setLoad(outcome);
      }
    });
    return () => {
      current = false;
    };
  }, [api, config, attempt]);

  const signOut = (
    <div>
      <button type="button" className={BUTTON_SECONDARY} onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );

  if (load === undefined) {
    return (
      <SessionMessage title="Opening your store">
        <p className="text-15 text-text-2" role="status">
          Reading your store from PayCore...
        </p>
      </SessionMessage>
    );
  }
  if (load.kind === 'refused') {
    return (
      <SessionMessage title="This admin stops here">
        <p className="text-15 text-text-2 leading-relaxed">{load.message}</p>
        {signOut}
      </SessionMessage>
    );
  }
  if (load.kind === 'failed') {
    return (
      <SessionMessage title="Your store could not be opened">
        <p className="text-15 text-text-2 leading-relaxed" role="alert">
          {load.message}
        </p>
        <div className="flex gap-8">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </button>
          <button type="button" className={BUTTON_SECONDARY} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </SessionMessage>
    );
  }
  if (load.kind === 'no_store') {
    return (
      <SessionMessage title="No store yet">
        <p className="text-15 text-text-2 leading-relaxed">
          There is no store for this owner key on PayCore yet.
        </p>
        <ForgetOnDevice owner={owner} />
        {signOut}
      </SessionMessage>
    );
  }
  return <StoreShell owner={owner} store={load.store} meta={load.meta} onSignOut={onSignOut} />;
}
