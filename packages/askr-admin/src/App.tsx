import { useState } from 'react';
import { Session } from './components/Session';
import { SignIn } from './components/SignIn';
import type { SessionDeps } from './lib/deps';
import type { PlanIntent } from './lib/plan-intent';
import type { Signer } from './lib/signer';
import { clearTabSignedIn, markTabSignedIn } from './lib/tab-session';

interface Props {
  createDeps: (signer: Signer) => SessionDeps;
  /** The paid plan the landing's "Choose <Plan>" opened the admin with, read once at boot (D2). */
  initialIntent?: PlanIntent;
}

/**
 * The signer lives in this component's memory only. A reload of the tab signs in again with the
 * key this device remembers (`tab-session`), and Sign out ends that. The plan chosen on the
 * landing lives here too, never in storage: it is acted on, dismissed, or dropped with the key
 * it was chosen for (Sign out, replacing the key).
 */
export function App({ createDeps, initialIntent }: Props) {
  const [deps, setDeps] = useState<SessionDeps>();
  /** The Store ID whose key the merchant chose to replace from inside the admin (K21). */
  const [replaceKeyOf, setReplaceKeyOf] = useState<string>();
  const [intent, setIntent] = useState<PlanIntent | undefined>(initialIntent);
  const dropIntent = () => setIntent(undefined);
  const intentProps = intent === undefined ? {} : { intent };
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
        {...intentProps}
        onDismissIntent={dropIntent}
      />
    );
  }
  return (
    <Session
      deps={deps}
      onSignOut={() => {
        clearTabSignedIn();
        dropIntent();
        setDeps(undefined);
      }}
      onReplaceKey={(storeId) => {
        clearTabSignedIn();
        dropIntent();
        setReplaceKeyOf(storeId);
        setDeps(undefined);
      }}
      {...intentProps}
      onIntentDone={dropIntent}
    />
  );
}
