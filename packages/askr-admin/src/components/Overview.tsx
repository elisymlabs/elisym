import type { StoreConfig } from '@elisym/askr';
import { KIND_CATALOG_AUTH, KIND_CONFIG } from '@elisym/askr';
import type { StoreStatus, StoreView } from '../lib/types';
import { usd } from '../lib/usage';
import { ConnectorStatus } from './ConnectorStatus';
import { Notice } from './Notice';
import { Section } from './Section';
import { SyncStatus } from './SyncStatus';
import { UsageMeter } from './UsageMeter';

interface Props {
  view: StoreView;
  config: StoreConfig | undefined;
}

const STATUS_TEXT: Readonly<Record<StoreStatus, string>> = {
  pending:
    'Pending. Your settings are saved; the assistant starts answering once the Askr operator activates your store.',
  active: 'Active. Your assistant is answering on your site.',
  suspended: 'Suspended. Your assistant does not answer. Contact the Askr operator.',
};

const KIND_NAMES: Readonly<Record<number, string>> = {
  [KIND_CONFIG]: 'store settings',
  [KIND_CATALOG_AUTH]: 'catalog key authorization',
  5: 'deletion',
};

const TOP_CLICKS = 10;

function dOfAddress(address: string): string {
  const parts = address.split(':');
  return parts.slice(2).join(':') || address;
}

export function Overview({ view, config }: Props) {
  const { tier, usage, events } = view;
  return (
    <div className="flex flex-col gap-16">
      <Section title="Status">
        <Notice tone={view.status === 'active' ? 'success' : 'warn'}>
          {STATUS_TEXT[view.status]}
        </Notice>
        {config === undefined ? (
          <p className="text-14 text-text-2">Your settings are not on the relay yet.</p>
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
        {tier === null ? null : (
          <div className="flex flex-col gap-12">
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
          </div>
        )}
        <dl className="text-14 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4">
          <dt className="text-text-2">Open conversations</dt>
          <dd>{usage.sessions}</dd>
          <dt className="text-text-2">Reserved today</dt>
          <dd>{usd(usage.today.reserved)}</dd>
        </dl>
      </Section>

      <Section
        title="Product link clicks"
        description="Clicks on product links in the chat. Advisory: a click is counted as the visitor's browser reports it."
      >
        {usage.clicks.length === 0 ? (
          <p className="text-14 text-text-2">No clicks yet.</p>
        ) : (
          <ul className="text-14 flex flex-col gap-4">
            {usage.clicks.slice(0, TOP_CLICKS).map((click) => (
              <li key={click.address} className="flex justify-between gap-12">
                <span className="truncate font-mono">{dOfAddress(click.address)}</span>
                <span>{click.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Waiting to publish"
        description="Changes you signed that the relay has not accepted yet."
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
            The relay refused a {KIND_NAMES[failing.kind] ?? `kind ${failing.kind} event`}{' '}
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
