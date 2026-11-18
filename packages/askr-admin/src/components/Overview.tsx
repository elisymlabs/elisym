import type { StoreConfig } from '@elisym/askr';
import { KIND_CATALOG_AUTH, KIND_CONFIG } from '@elisym/askr';
import { KIND_DELETION } from '@elisym/commerce';
import type { RelayReader } from '../lib/relay';
import type { StoreStatus, StoreView } from '../lib/types';
import { usd } from '../lib/usage';
import { CatalogSize } from './CatalogSize';
import { ConnectorStatus } from './ConnectorStatus';
import { Notice } from './Notice';
import { Section } from './Section';
import { SyncStatus } from './SyncStatus';
import { UsageMeter } from './UsageMeter';

interface Props {
  view: StoreView;
  config: StoreConfig | undefined;
  /** The settings shown are the ones O signed and the server holds until activation. */
  configFromServer: boolean;
  /** Reads the catalog to say when it is larger than the plan indexes. */
  catalogReader?: { reader: RelayReader; now: () => number };
}

const STATUS_TEXT: Readonly<Record<StoreStatus, string>> = {
  pending:
    'Your settings are saved; the assistant starts answering once the Askr operator activates your store.',
  active: 'Your assistant is answering on your site.',
  suspended: 'Your assistant does not answer. Contact the Askr operator.',
};

const KIND_NAMES: Readonly<Record<number, string>> = {
  [KIND_CONFIG]: 'store settings',
  [KIND_CATALOG_AUTH]: 'catalog key authorization',
  [KIND_DELETION]: 'deletion',
};

const TOP_CLICKS = 10;

function dOfAddress(address: string): string {
  const parts = address.split(':');
  return parts.slice(2).join(':') || address;
}

const STATUS_BADGE: Readonly<Record<StoreStatus, { label: string; tone: string }>> = {
  pending: { label: 'Pending', tone: 'badge-warn' },
  active: { label: 'Active', tone: 'badge-green' },
  suspended: { label: 'Suspended', tone: 'badge-error' },
};

export function Overview({ view, config, configFromServer, catalogReader }: Props) {
  const { tier, usage, events } = view;
  const badge = STATUS_BADGE[view.status];
  return (
    <div className="flex flex-col gap-32">
      <Section title="Status">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:gap-12">
          <span className={`badge self-start sm:self-auto ${badge.tone}`}>{badge.label}</span>
          <p className="text-14 text-text-2" role="status">
            {STATUS_TEXT[view.status]}
          </p>
        </div>
        {config === undefined ? (
          <p className="text-14 text-text-2">Your settings are not published yet.</p>
        ) : null}
        {config !== undefined && configFromServer ? (
          <p className="text-14 text-text-2">
            Your settings are shown as you signed them. They are published once your store is{' '}
            {view.status === 'suspended' ? 'reactivated' : 'activated'}.
          </p>
        ) : null}
        {view.nextAssistant === null ? null : (
          <Notice tone="info">
            An assistant key rotation is under way. It completes once settings naming the new
            assistant are published (Keys tab).
          </Notice>
        )}
      </Section>

      <Section
        title="Usage"
        description={
          tier === null
            ? 'No plan is assigned until your store is activated.'
            : `Plan: ${tier.name}`
        }
      >
        <dl className="grid grid-cols-1 gap-12 sm:grid-cols-3">
          <div className="rounded-10 bg-surface-2 flex flex-col gap-4 px-14 py-12">
            <dt className="text-12 text-text-2">Conversations so far</dt>
            <dd id="usage-conversations" className="text-24 font-semibold tabular-nums">
              {usage.conversations}
            </dd>
          </div>
          <div className="rounded-10 bg-surface-2 flex flex-col gap-4 px-14 py-12">
            <dt className="text-12 text-text-2">Open conversations</dt>
            <dd className="text-24 font-semibold tabular-nums">{usage.sessions}</dd>
          </div>
          <div className="rounded-10 bg-surface-2 flex flex-col gap-4 px-14 py-12">
            <dt className="text-12 text-text-2">Reserved today</dt>
            <dd className="text-24 font-semibold tabular-nums">{usd(usage.today.reserved)}</dd>
          </div>
        </dl>
        {tier === null ? null : (
          <div className="flex flex-col gap-16">
            <UsageMeter
              label="Today"
              used={usage.today.spent}
              limit={tier.dailyBudgetUsd}
              text={`${usd(usage.today.spent)} of ${usd(tier.dailyBudgetUsd)}`}
            />
            <UsageMeter
              label="This month"
              used={usage.month.spent}
              limit={tier.monthlyBudgetUsd}
              text={`${usd(usage.month.spent)} of ${usd(tier.monthlyBudgetUsd)}`}
            />
            <p className="text-13 text-text-2">
              Up to {tier.maxProducts} products, {tier.messagesPerSessionPerDay} questions per
              visitor per day, connector sync every {tier.syncIntervalMinutes} minutes.
            </p>
            {catalogReader === undefined || config === undefined ? null : (
              <CatalogSize
                reader={catalogReader.reader}
                now={catalogReader.now}
                config={config}
                maxProducts={tier.maxProducts}
              />
            )}
          </div>
        )}
        <p className="text-12 text-text-3">
          A conversation is one visitor's chat, up to 24 hours from their first message, that got at
          least one answer. Open conversations are the chats started in the last 24 hours.
        </p>
      </Section>

      <Section
        title="Product clicks"
        description="Product pages opened and add to cart presses from the chat's cards. Advisory: a click is counted as the visitor's browser reports it."
        flush
      >
        {usage.clicks.length === 0 ? (
          <p className="text-14 text-text-2 px-20 py-16">No clicks yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Product clicks">
              <thead>
                <tr>
                  <th>Product ID</th>
                  <th className="text-right">Page opened</th>
                  <th className="text-right">Added to cart</th>
                </tr>
              </thead>
              <tbody>
                {usage.clicks.slice(0, TOP_CLICKS).map((click) => (
                  <tr key={click.address}>
                    <td className="text-13 max-w-320 truncate font-mono">
                      {dOfAddress(click.address)}
                    </td>
                    <td className="text-right font-medium tabular-nums">{click.count}</td>
                    <td className="text-right font-medium tabular-nums">{click.carts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Waiting to publish"
        description="Changes you signed that are not published yet."
      >
        {events.pending === 0 ? (
          <p className="text-14 text-text-2">Nothing is waiting.</p>
        ) : (
          <p className="text-14">
            {events.pending} signed change{events.pending === 1 ? '' : 's'} waiting
            {view.status === 'active' ? '.' : ' for activation.'}
          </p>
        )}
        {events.failing.map((failing) => (
          <Notice key={failing.id} tone={failing.stopped ? 'error' : 'warn'}>
            Publishing was refused for a {KIND_NAMES[failing.kind] ?? `kind ${failing.kind} event`}{' '}
            {failing.failures} time{failing.failures === 1 ? '' : 's'}.{' '}
            {failing.stopped ? 'It is no longer retried: sign it again.' : 'It is retried.'}
          </Notice>
        ))}
      </Section>

      <Section title="Product sync">
        <SyncStatus sync={view.catalogSync} />
      </Section>

      <Section title="Connector">
        <ConnectorStatus connector={view.connector} />
      </Section>
    </div>
  );
}
