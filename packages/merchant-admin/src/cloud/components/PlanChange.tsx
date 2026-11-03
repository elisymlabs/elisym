import { type ReactNode, useState } from 'react';
import { Button } from '../../components/Button';
import { SettingRow } from '../../components/SettingRow';
import type { ApiAnswer, ConsoleApi } from '../lib/api';
import { type PlanNames, type PlanNotice, planReasonText } from '../lib/plan-change';
import type { StoreView } from '../lib/store-view';
import type { TierCard } from '../lib/tiers';
import { PlanChangeSheet } from './PlanChangeSheet';
import { PlanRequestRow } from './PlanRequestRow';
import { PlanScheduleRow } from './PlanScheduleRow';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  /** The plan catalog, once read: the plans' names and monthly prices. */
  tiers: readonly TierCard[] | undefined;
  billingUrl: string | undefined;
  loadTiers: () => Promise<ApiAnswer>;
  /** The server's clock now. */
  now: () => number;
  /** The plan moved, or may have: the store is read again. */
  onChanged: () => void;
  onOpenPage: (page: 'products' | 'settings') => void;
  /** A top-level navigation to Stripe (a card checkout of the plan picked). */
  navigate: (url: string) => void;
}

/** While a card request is in flight no other change is taken (plan 2.1): no Change plan then. */
const IN_FLIGHT: readonly string[] = ['charging', 'awaiting_confirmation', 'unknown'];

/**
 * The plan's change on the Plan & billing page (plan `cloud-plan-change.md`
 * 2.6), as the store view's `plan` says it: a card change on its way (or one
 * that ended without applying), a downgrade scheduled with its Keep, and
 * Change plan, or why the plan cannot change here.
 */
export function PlanChange({
  api,
  tenantId,
  view,
  tiers,
  billingUrl,
  loadTiers,
  now,
  onChanged,
  onOpenPage,
  navigate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<PlanNotice | undefined>(undefined);
  const { plan } = view;
  if (plan === undefined) {
    return null;
  }
  const names: PlanNames = {
    name: (tier) =>
      tiers?.find((card) => card.id === tier)?.name ?? (tier === view.tier ? view.tierName : tier),
    cents: (tier) => tiers?.find((card) => card.id === tier)?.monthlyCents,
  };
  const changed = (said?: PlanNotice) => {
    setNotice(said);
    onChanged();
  };
  const inFlight = plan.request !== undefined && IN_FLIGHT.includes(plan.request.status);

  let change: ReactNode = null;
  if (!plan.canChange) {
    change = <p className="text-14 text-text-2">{planReasonText(plan.reason)}</p>;
  } else if (!inFlight) {
    change = (
      <Button
        onClick={() => {
          setNotice(undefined);
          setOpen(true);
        }}
        className="self-start"
      >
        Change plan
      </Button>
    );
  }

  return (
    <>
      {notice === undefined ? null : (
        <SettingRow label="Plan change">
          <p
            role="status"
            data-tone={notice.tone}
            className={`text-14 font-medium ${notice.tone === 'ok' ? 'text-ok' : 'text-warn'}`}
          >
            {notice.text}
          </p>
        </SettingRow>
      )}
      {plan.request === undefined ? null : (
        <PlanRequestRow
          key={`${plan.request.id}:${plan.request.status}`}
          api={api}
          tenantId={tenantId}
          request={plan.request}
          names={names}
          current={view.tier}
          onChanged={changed}
        />
      )}
      {plan.scheduled === undefined ? null : (
        <PlanScheduleRow
          api={api}
          tenantId={tenantId}
          scheduled={plan.scheduled}
          names={names}
          current={view.tier}
          onChanged={changed}
        />
      )}
      {change === null ? null : <SettingRow label="Other plans">{change}</SettingRow>}
      {open ? (
        <PlanChangeSheet
          api={api}
          tenantId={tenantId}
          current={view.tier}
          billingRef={view.billingRef}
          billingUrl={billingUrl}
          cardRailOpen={view.card.open && view.card.refusal === undefined}
          navigate={navigate}
          names={names}
          loadTiers={loadTiers}
          now={now}
          onClose={() => setOpen(false)}
          onDone={(said) => {
            setOpen(false);
            changed(said);
          }}
          onStale={onChanged}
          onOpenPage={onOpenPage}
        />
      ) : null}
    </>
  );
}
