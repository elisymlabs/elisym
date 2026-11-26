import { PAYCORE_ONBOARDING_URL, type PayCoreStoreView, discoveredStore } from '../lib/paycore';
import { npubOf } from '../lib/signer';
import { PAYCORE_CURRENCY, type StoreForm, linkOf } from '../lib/store-form';
import type { PayCoreChoices } from '../lib/use-paycore-choices';
import { Notice } from './Notice';

interface Props {
  form: StoreForm;
  onChange: (form: StoreForm) => void;
  /** The owner's PayCore stores; none where the page does not read them. */
  choices: PayCoreChoices | undefined;
}

function OnboardingLink({ text }: { text: string }) {
  return (
    <a className="underline" href={PAYCORE_ONBOARDING_URL} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}

function StoreLine({ store, fallbackKey }: { store?: PayCoreStoreView; fallbackKey: string }) {
  return (
    <span className="flex flex-col gap-2">
      {store?.name === undefined ? null : <span className="font-medium">{store.name}</span>}
      <span className="text-13 font-mono break-all">{npubOf(fallbackKey)}</span>
    </span>
  );
}

/**
 * The PayCore store a `paycore` source sells from (C7): the linked one, active
 * or not, or the newest one discovery finds through the owner's 30490s, or
 * a link to set one up in PayCore.
 */
export function PayCoreSource({ form, onChange, choices }: Props) {
  const stores = choices?.state === 'read' ? choices.stores : [];
  const discovered = discoveredStore(stores);
  const link = form.payCore;
  const use = (store: PayCoreStoreView) =>
    onChange({ ...form, payCore: linkOf(store), currency: PAYCORE_CURRENCY });

  let store;
  if (link !== undefined && link.active) {
    store = (
      <div className="flex flex-col gap-4">
        <span className="text-14 font-semibold">PayCore store</span>
        <StoreLine store={stores.find((entry) => entry.key === link.key)} fallbackKey={link.key} />
      </div>
    );
  } else if (link !== undefined) {
    const other = discovered !== undefined && discovered.key !== link.key ? discovered : undefined;
    store = (
      <Notice tone="warn">
        <span className="flex flex-col gap-8">
          <span className="font-semibold">PayCore store - authorization inactive</span>
          <StoreLine
            store={stores.find((entry) => entry.key === link.key)}
            fallbackKey={link.key}
          />
          {link.mode === 'self-host' ? (
            <span>
              Your PayCore authorization of this store is revoked or expired, so its products show
              without a Buy button. The store runs on your own PayCore node: re-authorize it there,
              with your owner key
              {other === undefined ? '.' : ', or sell from your other store.'}
            </span>
          ) : (
            <span>
              Your PayCore authorization of this store is revoked or expired, so its products show
              without a Buy button. <OnboardingLink text="Re-authorize it in PayCore" />
              {other === undefined ? '.' : ', or sell from your other store.'}
            </span>
          )}
          {other === undefined ? null : (
            <span>
              <button type="button" className="btn" onClick={() => use(other)}>
                Use {other.name ?? npubOf(other.key)} instead
              </button>
            </span>
          )}
        </span>
      </Notice>
    );
  } else if (choices === undefined || choices.state === 'reading') {
    store = <p className="text-13 text-text-2">Looking for your PayCore store...</p>;
  } else if (choices.state === 'failed') {
    store = (
      <Notice tone="warn">
        Your PayCore stores could not be read.{' '}
        <button type="button" className="underline" onClick={choices.retry}>
          Retry
        </button>
      </Notice>
    );
  } else if (discovered === undefined) {
    store = (
      <Notice tone="info">
        No PayCore store is set up for this Store ID yet.{' '}
        <OnboardingLink text="Set one up in PayCore" />, then come back and choose it here.
      </Notice>
    );
  } else {
    store = (
      <div className="flex flex-col gap-8">
        <span className="text-14 font-semibold">Your PayCore store</span>
        <StoreLine store={discovered} fallbackKey={discovered.key} />
        <span>
          <button type="button" className="btn" onClick={() => use(discovered)}>
            Sell from this store
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      {store}
      <p className="text-13 text-text-2">
        A PayCore store&apos;s prices are in {PAYCORE_CURRENCY}, so the currency is{' '}
        {PAYCORE_CURRENCY}. Your plan&apos;s product limit applies: past it, the assistant leaves
        the rest of the store&apos;s products out. Add the checkout script from the Embed tab to
        your pages for the Buy button.
      </p>
    </div>
  );
}
