import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { useEffect, useState } from 'react';
import { MOVED_KEY } from '../lib/errors';
import type { HostedConfig } from '../lib/hosted-config';
import { ProvenPayouts } from '../lib/proven';
import { type SessionLoad, loadSession } from '../lib/session';
import type { CompletedMove, StoreApi, StoreSession } from '../lib/store-session';
import type { Meta } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { ForgetOnDevice } from './ForgetOnDevice';
import { Onboarding } from './Onboarding';
import { SessionMessage } from './SessionMessage';
import { StoreShell } from './StoreShell';

interface Props {
  api: StoreApi;
  config: HostedConfig;
  /** O, hex. */
  owner: string;
  /** O's signature, by the signer the page holds. */
  signEvent: (template: EventTemplate) => Promise<NostrEvent>;
  onSignOut: () => void;
  /** A move was taken: the page goes on as the new owner. */
  onSwitchOwner: (move: CompletedMove) => void;
  /** Signed in by a move: the store's setup request to follow. */
  moveRequestId?: string;
  /** Tests shorten the wait between reads of a followed request. */
  sleep?: (ms: number) => Promise<void>;
}

function localNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** A signed-in owner: the server checked against the committed config, then their store. */
export function Session({
  api,
  config,
  owner,
  signEvent,
  onSignOut,
  onSwitchOwner,
  moveRequestId,
  sleep,
}: Props) {
  const [load, setLoad] = useState<SessionLoad | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [proven] = useState(() => new ProvenPayouts());

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
  if (load.kind === 'moved') {
    return (
      <SessionMessage title="This store moved">
        <p className="text-15 text-text-2 leading-relaxed" role="alert">
          {MOVED_KEY} Sign in with the new owner key to open it.
        </p>
        <ForgetOnDevice owner={owner} />
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
  const session = (meta: Meta): StoreSession => ({
    api,
    owner,
    operator: config.operator,
    meta,
    signEvent,
    proven,
    localNow,
    switchOwner: onSwitchOwner,
    ...(sleep === undefined ? {} : { sleep }),
  });
  if (load.kind === 'no_store') {
    return (
      <Onboarding
        session={session(load.meta)}
        onOpen={() => setAttempt((count) => count + 1)}
        onSignOut={onSignOut}
      />
    );
  }
  return (
    <StoreShell
      session={session(load.meta)}
      store={load.store}
      onSignOut={onSignOut}
      {...(moveRequestId === undefined ? {} : { moveRequestId })}
    />
  );
}
