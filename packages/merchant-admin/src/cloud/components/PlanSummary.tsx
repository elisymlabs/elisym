import type { ReactNode } from 'react';
import { SettingRow } from '../../components/SettingRow';
import { SettingsSection } from '../../components/SettingsSection';
import type { StoreStatus } from '../lib/status';
import { type StoreView, shownDate, shownTime } from '../lib/store-view';

interface Props {
  view: StoreView;
  status: StoreStatus | undefined;
  /** The plan's price as the catalog writes it ("$29/mo"), once read. */
  price: string | undefined;
  /** Rows under the plan's own: its change, a change on its way or scheduled. */
  children?: ReactNode;
}

/** The plan, its paid time and this month's use of it, in words. */
export function PlanSummary({ view, status, price, children }: Props) {
  const cap = status?.usage.ordersPerMonth;
  return (
    <SettingsSection title="Your plan">
      <SettingRow label="Plan">
        <span className="text-14">
          {price === undefined
            ? view.tierName
            : `${view.tierName}, ${price.replace(/\/mo$/, '/month')}`}
        </span>
      </SettingRow>
      <SettingRow label="Paid until">
        <span className="text-14">
          {view.paidUntil === undefined ? 'Not paid yet' : shownDate(view.paidUntil)}
        </span>
      </SettingRow>
      {view.partner === undefined ? null : (
        <SettingRow label="Your partner pays until">
          <span className="text-14">
            {view.partner.paidUntil === undefined
              ? 'Not paid yet'
              : shownDate(view.partner.paidUntil)}
          </span>
        </SettingRow>
      )}
      {view.payBy === undefined ? null : (
        <SettingRow
          label="Pay by"
          help="Payments close at this time; after it the store is deleted."
        >
          <span className="text-14 text-error">{shownTime(view.payBy)}</span>
        </SettingRow>
      )}
      {status === undefined ? null : (
        <SettingRow label="Paid orders this month">
          <span className="text-14">
            {status.usage.paidOrders.toLocaleString('en-US')}
            {cap === undefined ? ', no cap' : ` of ${cap.toLocaleString('en-US')}`}
          </span>
        </SettingRow>
      )}
      {children}
    </SettingsSection>
  );
}
