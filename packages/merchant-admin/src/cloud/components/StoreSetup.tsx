import type { ConsoleApi } from '../lib/api';
import type { OwnerTools } from '../lib/owner-tools';
import { domainOf, nip05Of } from '../lib/settings';
import { useKeptStore } from '../lib/use-kept-store';
import { useStatus } from '../lib/use-status';
import { Card } from './Card';
import { DomainPanel } from './DomainPanel';
import { InstallStep } from './InstallStep';
import { PayoutsPanel } from './PayoutsPanel';
import { ProductsForm } from './ProductsForm';
import { RunStateLine } from './RunStateLine';
import { SettingsPanel } from './SettingsPanel';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  ownerPubkey: string;
  /** The store's network (its snippet's `network`). */
  network: string;
  tools: OwnerTools;
  activated: boolean;
  withdrawn: boolean;
  /** The store changed here: its view is read again. */
  onStoreChanged: () => void;
}

/** Setting up the store: its settings, domain, products and snippets, from one read of what is kept. */
export function StoreSetup({
  api,
  tenantId,
  ownerPubkey,
  network,
  tools,
  activated,
  withdrawn,
  onStoreChanged,
}: Props) {
  const kept = useKeptStore(api, tenantId);
  const poll = useStatus(api, tenantId, () => tools.localNow() * 1000);
  const status = poll.status?.gone === false ? poll.status : undefined;
  const { read } = kept;
  // The domain as it is kept (the record names what the store says), not as typed.
  const domain = read === undefined ? undefined : domainOf(nip05Of(read.form.domain));
  return (
    <>
      {status === undefined ? null : (
        <div className="flex w-full flex-col gap-4">
          <RunStateLine
            runState={status.runState}
            onCheckAgain={poll.expired ? poll.watch : undefined}
          />
          <p className="text-13 text-text-2">
            Paid orders this month: {status.usage.paidOrders.toLocaleString('en-US')}
            {status.usage.ordersPerMonth === undefined
              ? ''
              : ` of ${status.usage.ordersPerMonth.toLocaleString('en-US')} on your plan`}
            .
          </p>
        </div>
      )}
      {status === undefined ? null : (
        <Card title="Products">
          <div className="mt-16">
            <ProductsForm
              api={api}
              tenantId={tenantId}
              kept={kept}
              status={status}
              poll={poll}
              published={activated}
            />
          </div>
        </Card>
      )}
      {read?.storePubkey !== undefined && (network === 'mainnet' || network === 'devnet') ? (
        <PayoutsPanel
          api={api}
          tenantId={tenantId}
          storePubkey={read.storePubkey}
          network={network}
          kept={kept}
          tools={tools}
          activated={activated}
          withdrawn={withdrawn}
          onStoreChanged={onStoreChanged}
        />
      ) : null}
      {read?.storePubkey !== undefined && read.productNames.length > 0 ? (
        <Card title="Sell on your page">
          <div className="mt-16">
            <InstallStep
              storePubkey={read.storePubkey}
              products={read.productNames}
              relayHints={read.relayHints}
              network={network}
              loader={read.loader}
            />
          </div>
        </Card>
      ) : null}
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
