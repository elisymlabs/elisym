import { useState } from 'react';
import { Button } from '../../components/Button';
import { Stepper } from '../../components/Stepper';
import type { ConsoleApi } from '../lib/api';
import type { OwnerTools } from '../lib/owner-tools';
import { domainOf, nip05Of } from '../lib/settings';
import { type SetupStepKey, setupSteps } from '../lib/setup-steps';
import type { StoreView } from '../lib/store-view';
import { useKeptStore } from '../lib/use-kept-store';
import { useStatus } from '../lib/use-status';
import { BillingPanel } from './BillingPanel';
import { Card } from './Card';
import { DomainPanel } from './DomainPanel';
import { InstallStep } from './InstallStep';
import { LaunchChecklist } from './LaunchChecklist';
import { NameStep } from './NameStep';
import { PayoutsPanel } from './PayoutsPanel';
import { ProductsForm } from './ProductsForm';
import { SettingsPanel } from './SettingsPanel';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  npub: string;
  ownerPubkey: string;
  tools: OwnerTools;
  billingUrl: string | undefined;
  navigate: (url: string) => void;
  /** The store changed here (paid, launched, withdrawn): its view is read again. */
  onStoreChanged: () => void;
}

/**
 * Setting up a store not launched yet, one step at a time (plan section 3):
 * each step's state is read from the store's status, so a reload resumes
 * where the data says. A step done can be opened again; Advanced holds
 * everything else a store can set.
 */
export function SetupFlow({
  api,
  tenantId,
  view,
  npub,
  ownerPubkey,
  tools,
  billingUrl,
  navigate,
  onStoreChanged,
}: Props) {
  const poll = useStatus(api, tenantId, () => tools.localNow() * 1000);
  const kept = useKeptStore(api, tenantId);
  const [chosen, setChosen] = useState<SetupStepKey | undefined>(undefined);
  const status = poll.status;

  if (status === undefined) {
    return (
      <Card title="Set up your store">
        <p role={poll.error === '' ? 'status' : 'alert'} className="text-14 text-text-2 mt-12">
          {poll.error === '' ? 'Loading...' : poll.error}
        </p>
      </Card>
    );
  }
  if (status.gone) {
    return null;
  }
  const steps = setupSteps(status, view.launch === 'operator');
  const current = steps.find((step) => step.state === 'current')?.key ?? 'launch';
  const open = steps.find((step) => step.key === chosen && !step.locked)?.key ?? current;
  const network =
    view.network === 'mainnet' || view.network === 'devnet' ? view.network : undefined;
  const read = kept.read;
  const domain = read === undefined ? undefined : domainOf(nip05Of(read.form.domain));

  const unlocked = new Set(steps.filter((step) => !step.locked).map((step) => step.key));
  // A step the merchant edits stays open until they choose another or its save is kept: an
  // advance never hides what they are typing.
  const pin = () => setChosen(open);
  // A step's save kept: its pin goes, and the steps are read again now (not at the next poll).
  const settle = (key: SetupStepKey) => {
    setChosen((was) => (was === key ? undefined : was));
    poll.watch();
  };
  const named = status.kept.name !== undefined;

  let payoutsNode: React.ReactNode;
  if (read?.storePubkey === undefined || network === undefined) {
    payoutsNode = (
      <p role="status" className="text-14 text-text-2">
        Preparing your store: this takes a minute.
      </p>
    );
  } else if (named) {
    payoutsNode = (
      <PayoutsPanel
        api={api}
        tenantId={tenantId}
        storePubkey={read.storePubkey}
        network={network}
        kept={kept}
        tools={tools}
        activated={view.activated}
        withdrawn={view.withdrawn}
        onStoreChanged={onStoreChanged}
        onSettled={() => settle('payouts')}
      />
    );
  } else {
    payoutsNode = (
      <div className="flex flex-col items-start gap-8">
        <p className="text-14 text-text-2">Name your store first: its payouts go with it.</p>
        <Button size="sm" onClick={() => setChosen('name')}>
          Name your store
        </Button>
      </div>
    );
  }

  // Every step that can open is mounted (only the open one shows), so switching keeps drafts.
  const bodies: { key: SetupStepKey; node: React.ReactNode }[] = [
    {
      key: 'plan',
      node: (
        <p className="text-14 text-text-2">
          Plan: {status.tierName}. Your owner key signs you in: keep it saved.
        </p>
      ),
    },
    {
      key: 'key',
      node: <p className="text-14 text-text-2">Your owner key signs you in: keep it saved.</p>,
    },
    {
      key: 'pay',
      node: (
        <>
          {status.effectivePaidUntil !== undefined && status.storePubkey === undefined ? (
            <p role="status" className="text-14 text-text-2">
              Paid. Preparing your store: this takes a minute.
            </p>
          ) : null}
          <BillingPanel
            api={api}
            tenantId={tenantId}
            view={view}
            billingUrl={billingUrl}
            navigate={navigate}
            onStale={onStoreChanged}
          />
        </>
      ),
    },
    {
      key: 'name',
      node: (
        <NameStep
          api={api}
          tenantId={tenantId}
          status={status}
          poll={poll}
          kept={kept}
          onSettled={() => settle('name')}
        />
      ),
    },
    {
      key: 'payouts',
      node: payoutsNode,
    },
    {
      key: 'products',
      node: (
        <ProductsForm
          api={api}
          tenantId={tenantId}
          kept={kept}
          status={status}
          poll={poll}
          published={false}
          onSettled={() => settle('products')}
        />
      ),
    },
    {
      key: 'install',
      node:
        read?.storePubkey !== undefined && read.productNames.length > 0 ? (
          <InstallStep
            storePubkey={read.storePubkey}
            products={read.productNames}
            relayHints={read.relayHints}
            network={view.network}
            loader={read.loader}
          />
        ) : (
          <p className="text-14 text-text-2">Add a product first: each gets its own button.</p>
        ),
    },
    {
      key: 'launch',
      node: (
        <LaunchChecklist
          api={api}
          tenantId={tenantId}
          status={status}
          poll={poll}
          byOperator={view.launch === 'operator'}
          domain={read === undefined ? undefined : nip05Of(read.form.domain)}
          onLaunched={onStoreChanged}
        />
      ),
    },
  ];

  return (
    <>
      <Card title="Set up your store">
        <div className="mt-16 grid gap-24 md:grid-cols-[200px_1fr]">
          <Stepper
            steps={steps}
            selected={open}
            onSelect={(key) => setChosen(steps.find((step) => step.key === key)?.key)}
          />
          <div className="flex min-w-0 flex-col gap-16">
            {view.launch === 'operator' ? (
              <p className="text-13 text-text-2 leading-relaxed">
                We launch this store once it is set up, after confirming with you that its owner key
                is <span className="font-mono break-all">{npub}</span>.
              </p>
            ) : null}
            {bodies
              .filter((each) => unlocked.has(each.key))
              .map((each) => (
                <div
                  key={each.key}
                  hidden={each.key !== open}
                  onInputCapture={pin}
                  onChangeCapture={pin}
                  className="flex min-w-0 flex-col gap-16"
                >
                  {each.node}
                </div>
              ))}
          </div>
        </div>
      </Card>
      <details className="rounded-20 border-line bg-surface w-full border p-24">
        <summary className="text-16 cursor-pointer font-semibold">Advanced</summary>
        <div className="mt-16 flex flex-col gap-16">
          <SettingsPanel api={api} tenantId={tenantId} kept={kept} />
          {read !== undefined && domain !== undefined ? (
            <DomainPanel
              api={api}
              tenantId={tenantId}
              domain={domain}
              ownerPubkey={ownerPubkey}
              storePubkey={read.storePubkey}
            />
          ) : null}
        </div>
      </details>
    </>
  );
}
