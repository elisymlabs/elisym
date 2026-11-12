import { useState } from 'react';
import { Session } from './components/Session';
import { SignIn } from './components/SignIn';
import type { SessionDeps } from './lib/deps';
import type { Nip07Provider, Signer } from './lib/signer';

interface Props {
  createDeps: (signer: Signer) => SessionDeps;
  findExtension: () => Nip07Provider | undefined;
}

/** The signer lives in this component's memory only: a reload signs out. */
export function App({ createDeps, findExtension }: Props) {
  const [deps, setDeps] = useState<SessionDeps>();
  if (deps === undefined) {
    return (
      <SignIn findExtension={findExtension} onSigner={(signer) => setDeps(createDeps(signer))} />
    );
  }
  return <Session deps={deps} onSignOut={() => setDeps(undefined)} />;
}
