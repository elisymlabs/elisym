import { useState } from 'react';
import { Session } from './components/Session';
import { SignIn } from './components/SignIn';
import type { SessionDeps } from './lib/deps';
import type { Signer } from './lib/signer';

interface Props {
  createDeps: (signer: Signer) => SessionDeps;
}

/** The signer lives in this component's memory only: a reload signs out. */
export function App({ createDeps }: Props) {
  const [deps, setDeps] = useState<SessionDeps>();
  /** The Store ID whose key the merchant chose to replace from inside the admin (K20). */
  const [replaceKeyOf, setReplaceKeyOf] = useState<string>();
  if (deps === undefined) {
    return (
      <SignIn
        key={replaceKeyOf ?? 'sign-in'}
        replaceKeyOf={replaceKeyOf}
        recover={async (signer, from) => {
          await createDeps(signer).api.recover(from);
        }}
        onSigner={(signer) => {
          setReplaceKeyOf(undefined);
          setDeps(createDeps(signer));
        }}
      />
    );
  }
  return (
    <Session
      deps={deps}
      onSignOut={() => setDeps(undefined)}
      onReplaceKey={(storeId) => {
        setReplaceKeyOf(storeId);
        setDeps(undefined);
      }}
    />
  );
}
