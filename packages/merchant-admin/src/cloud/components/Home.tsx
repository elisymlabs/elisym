import { useCallback, useEffect, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { type RelayQuery, keyInUse } from '../lib/key-in-use';
import type { OwnerTools } from '../lib/owner-tools';
import type { CheckoutReturn } from '../lib/start';
import { KeyInUseWarning } from './KeyInUseWarning';
import { PartnerView } from './PartnerView';
import { RedeemForm } from './RedeemForm';
import { SignupForm } from './SignupForm';
import { Store } from './Store';

interface Props {
  npub: string;
  pubkey: string;
  api: ConsoleApi;
  relayQuery: RelayQuery;
  /** The plan a `/start` link chose, if the console was opened from one. */
  startTier: string | undefined;
  termsUrl: string | undefined;
  billingUrl: string | undefined;
  navigate: (url: string) => void;
  checkoutReturn: CheckoutReturn | undefined;
  tools: OwnerTools;
  onSignOut: () => void;
}

type Owner =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'none'; termsVersion: string }
  | { state: 'store'; tenantId: string }
  /** Refused as an owner: a partner key (the partner view says if it is not one either). */
  | { state: 'partner' };

/** The signed-in console: the owner's store, or how this key gets one. */
export function Home({
  npub,
  pubkey,
  api,
  relayQuery,
  startTier,
  termsUrl,
  billingUrl,
  navigate,
  checkoutReturn,
  tools,
  onSignOut,
}: Props) {
  const [owner, setOwner] = useState<Owner>({ state: 'loading' });
  const [inUse, setInUse] = useState(false);

  const load = useCallback(async () => {
    const answer = await api.request('GET', '/owner');
    const tenantId = fieldOf(answer.body, 'tenantId');
    const termsVersion = fieldOf(answer.body, 'termsVersion');
    if (answer.status === 403) {
      setOwner({ state: 'partner' });
    } else if (answer.status !== 200 || typeof termsVersion !== 'string') {
      setOwner({ state: 'failed', message: explain(fieldOf(answer.body, 'error'), answer.status) });
    } else if (typeof tenantId === 'string') {
      setOwner({ state: 'store', tenantId });
    } else {
      setOwner({ state: 'none', termsVersion });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let current = true;
    const check = async () => {
      const found = await keyInUse(relayQuery, pubkey).catch(() => false);
      if (current) {
        setInUse(found);
      }
    };
    void check();
    return () => {
      current = false;
    };
  }, [relayQuery, pubkey]);

  return (
    <AuthLayout owner={{ npub, onSignOut }}>
      <div className="flex w-full max-w-640 flex-col gap-16">
        {owner.state === 'loading' ? <p className="text-14 text-text-3">Loading...</p> : null}
        {owner.state === 'failed' ? (
          <div className="flex flex-col items-start gap-12">
            <p role="alert" className="text-14 text-error">
              {owner.message}
            </p>
            <Button
              onClick={() => {
                setOwner({ state: 'loading' });
                void load();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {owner.state === 'store' ? (
          <Store
            api={api}
            tenantId={owner.tenantId}
            npub={npub}
            pubkey={pubkey}
            billingUrl={billingUrl}
            navigate={navigate}
            checkoutReturn={checkoutReturn}
            tools={tools}
          />
        ) : null}
        {owner.state === 'partner' ? <PartnerView api={api} /> : null}
        {owner.state === 'none' && inUse ? <KeyInUseWarning /> : null}
        {owner.state === 'none' && startTier !== undefined ? (
          <SignupForm
            api={api}
            tier={startTier}
            termsVersion={owner.termsVersion}
            termsUrl={termsUrl}
            onDone={() => void load()}
            onTermsChanged={() => void load()}
          />
        ) : null}
        {owner.state === 'none' ? <RedeemForm api={api} onDone={() => void load()} /> : null}
      </div>
    </AuthLayout>
  );
}
