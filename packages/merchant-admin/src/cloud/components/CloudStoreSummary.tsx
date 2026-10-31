import { SettingRow } from '../../components/SettingRow';
import { SettingsSection } from '../../components/SettingsSection';
import type { StoreStatus } from '../lib/status';
import { type StoreView, shownDate } from '../lib/store-view';
import { RunStateLine } from './RunStateLine';

interface Props {
  view: StoreView;
  /** The store's status, once read and not gone (its run state and this month's paid orders). */
  status: StoreStatus | undefined;
  /** The plan's price as the catalog writes it ("$29/mo"), once read. */
  price: string | undefined;
  /** The status poll ran out: offered to read it again. */
  onCheckAgain: (() => void) | undefined;
}

/** "$29/mo" as a person reads it. */
function perMonth(price: string): string {
  return price.replace(/\/mo$/, '/month');
}

/**
 * The store at a glance, in words (plan `admin-onboarding.md` 2.6): its plan
 * and price, whether it is live, its paid time, whether its payments are
 * real, and this month's paid orders. Its id is in Help.
 */
export function CloudStoreSummary({ view, status, price, onCheckAgain }: Props) {
  const live = view.activated && view.exported === undefined;
  const cap = status?.usage.ordersPerMonth;
  return (
    <SettingsSection title="Your store">
      <SettingRow label="Plan">
        <span className="text-14">
          {price === undefined ? view.tierName : `${view.tierName}, ${perMonth(price)}`}
        </span>
      </SettingRow>
      <SettingRow label="Status">
        {live && status !== undefined ? (
          <RunStateLine runState={status.runState} onCheckAgain={onCheckAgain} />
        ) : (
          <span className="text-14">{live ? 'Live' : 'Set up, not live yet'}</span>
        )}
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
        <SettingRow label="Pay by" help="Unpaid after this day, the store is deleted.">
          <span className="text-14 text-error">{shownDate(view.payBy)}</span>
        </SettingRow>
      )}
      <SettingRow
        label="Payments"
        help={view.network === 'devnet' ? 'Test money only: nothing real is paid.' : undefined}
      >
        <span className="text-14">
          {view.network === 'devnet' ? 'Test payments' : 'Live payments'}
        </span>
      </SettingRow>
      {status === undefined ? null : (
        <SettingRow label="Paid orders this month">
          <span className="text-14">
            {status.usage.paidOrders.toLocaleString('en-US')}
            {cap === undefined ? ', no cap' : ` of ${cap.toLocaleString('en-US')}`}
          </span>
        </SettingRow>
      )}
    </SettingsSection>
  );
}
