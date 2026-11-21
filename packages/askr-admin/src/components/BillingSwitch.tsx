import { YEARLY_DISCOUNT_LABEL } from '../lib/plans';
import type { BillingInterval } from '../lib/types';
import { Segmented } from './Segmented';

const OPTIONS: readonly { value: BillingInterval; label: string }[] = [
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

interface Props {
  value: BillingInterval;
  onChange: (value: BillingInterval) => void;
}

/** Monthly or yearly billing, with what yearly saves, as the landing's switch. */
export function BillingSwitch({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-12">
      <Segmented label="Billing period" options={OPTIONS} value={value} onChange={onChange} />
      <span
        id="yearly-saving"
        className="bg-surface-2 text-12 text-text rounded-full px-10 py-4 font-medium"
      >
        {`Save ${YEARLY_DISCOUNT_LABEL}`}
      </span>
    </div>
  );
}
