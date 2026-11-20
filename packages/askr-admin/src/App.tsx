import { useState } from 'react';
import { Session } from './components/Session';
import { SignIn } from './components/SignIn';
import type { SessionDeps } from './lib/deps';
import type { Signer } from './lib/signer';
import { clearTabSignedIn, markTabSignedIn } from './lib/tab-session';

interface Props {
  createDeps: (signer: Signer) => SessionDeps;
}

/**
 * The signer lives in this component's memory only. A reload of the tab signs in again with the
 * key this device remembers (`tab-session`), and Sign out ends that.
 */
export function App({ createDeps }: Props) {
  const [deps, setDeps] = useState<SessionDeps>();
  /** The Store ID whose key the merchant chose to replace from inside the admin (K21). */
  const [replaceKeyOf, setReplaceKeyOf] = useState<string>();
  if (deps === undefined) {
    return (
      <SignIn
        key={replaceKeyOf ?? 'sign-in'}
        replaceKeyOf={replaceKeyOf}
        recover={async (signer, from, dryRun) => {
          await createDeps(signer).api.recover(from, dryRun);
        }}
        onSigner={(signer) => {
          markTabSignedIn(signer.pubkey);
          setReplaceKeyOf(undefined);
          setDeps(createDeps(signer));
        }}
      />
    );
  }
  return (
    <Session
      deps={deps}
      onSignOut={() => {
        clearTabSignedIn();
        setDeps(undefined);
      }}
      onReplaceKey={(storeId) => {
        clearTabSignedIn();
        setReplaceKeyOf(storeId);
        setDeps(undefined);
      }}
    />
  );
}
