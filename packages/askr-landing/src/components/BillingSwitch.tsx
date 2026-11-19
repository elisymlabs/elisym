import { YEARLY_DISCOUNT_BPS } from '../constants';
import { Segmented } from './Segmented';

export type Billing = 'monthly' | 'yearly';

const OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const;

interface Props {
  value: Billing;
  onChange: (value: Billing) => void;
}

/** Monthly or yearly billing, with what yearly saves. */
export function BillingSwitch({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-12">
      <Segmented label="Billing period" options={OPTIONS} value={value} onChange={onChange} />
      <span className="bg-surface-2 text-13 text-text rounded-full px-12 py-6 font-medium">
        {`Save ${YEARLY_DISCOUNT_BPS / 100}% yearly`}
      </span>
    </div>
  );
}
