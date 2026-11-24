import { type ReactNode, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { STALE_RELOADED, errorMessage } from '../lib/errors';
import { type SavedPayouts, expectedPayouts } from '../lib/payout-rows';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY, CARD } from '../styles';
import { AuthorizationSection } from './AuthorizationSection';
import { CreateStore } from './CreateStore';
import { ForgetOnDevice } from './ForgetOnDevice';
import { InboxRelays } from './InboxRelays';
import { Notice } from './Notice';
import { PayoutListSection } from './PayoutListSection';
import { PayoutsForm } from './PayoutsForm';

interface Props {
  session: StoreSession;
  /** Open the store's own pages. */
  onOpen: () => void;
  onSignOut: () => void;
}

export const FIRST_SAVE_NEEDS_PAYOUT =
  'Your settings can be saved only with a payout address signed by its wallet: add one at least.';

/**
 * A new store, step by step: create it, then its first payouts and inbox
 * relays (the first config save), then the payout list and the authorization
 * O signs, then products.
 */
export function Onboarding({ session, onOpen, onSignOut }: Props) {
  const [view, setView] = useState<StoreView | undefined>(undefined);
  const [saved, setSaved] = useState<SavedPayouts | undefined>(undefined);
  const [relays, setRelays] = useState<string[]>(session.meta.inboxRelays);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const reload = (after?: string) => {
    session.api.store().then(
      (next) => {
        setView(next);
        setNotice(after);
      },
      (error: unknown) => setNotice(errorMessage(error)),
    );
  };

  const config = view?.config ?? null;
  let title: string;
  let step: ReactNode;
  if (view === undefined) {
    title = 'Create your store';
    step = <CreateStore session={session} onCreated={setView} />;
  } else if (config === null) {
    title = 'Your store';
    step = <Notice tone="warn">Your store has no settings yet. Reload the page.</Notice>;
  } else if (saved === undefined && config.draftPayouts.length === 0) {
    title = 'Where buyers pay you';
    step = (
      <div className="flex flex-col gap-16">
        <p className="text-14 text-text-2">{FIRST_SAVE_NEEDS_PAYOUT}</p>
        <PayoutsForm
          key={config.revision}
          session={session}
          config={config}
          edit={{ inboxRelays: relays }}
          onSaved={(next, payouts) => {
            setSaved({ payouts, revision: next.revision });
            setView({ ...view, config: next });
            reload();
          }}
          onStale={() => reload(STALE_RELOADED)}
        >
          <InboxRelays allowed={session.meta.inboxRelays} selected={relays} onChange={setRelays} />
        </PayoutsForm>
      </div>
    );
  } else {
    const payto = view.ownerEvents.payto;
    const finished = payto !== null && !view.payouts.needsSigning && view.ownerEvents.auth !== null;
    title = 'Sign with your owner key';
    step = (
      <div className="flex flex-col gap-24">
        <PayoutListSection
          session={session}
          view={view}
          payouts={expectedPayouts(saved, config)}
          onChanged={() => reload()}
        />
        <AuthorizationSection session={session} view={view} onChanged={() => reload()} />
        {finished ? (
          <section className="flex flex-col gap-8" id="onboarding-products">
            <h2 className="text-16 font-semibold">Next: your products</h2>
            <p className="text-14 text-text-2">
              Add the products you sell. Product editing comes to this admin next; your store page
              shows what is left to do.
            </p>
          </section>
        ) : null}
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={onOpen}>
            Open your store
          </button>
        </div>
      </div>
    );
  }

  return (
    <AuthLayout>
      <div className={`${CARD} flex max-w-720 flex-col gap-24`}>
        <div className="flex flex-wrap items-center justify-between gap-12">
          <h1 className="text-24 font-semibold tracking-tight">{title}</h1>
          <button type="button" className={BUTTON_SECONDARY} onClick={onSignOut}>
            Sign out
          </button>
        </div>
        {notice === undefined ? null : <Notice tone="error">{notice}</Notice>}
        {step}
        <ForgetOnDevice owner={session.owner} />
      </div>
    </AuthLayout>
  );
}
