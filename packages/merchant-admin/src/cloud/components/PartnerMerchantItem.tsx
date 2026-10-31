import { type PartnerMerchantView, STATUS_TEXT } from '../lib/partner';
import { shownTime } from '../lib/store-view';
import { VolumeText } from './VolumeText';

interface Props {
  merchant: PartnerMerchantView;
}

/** One of the partner's merchants: its status, its own paid time and its volume. */
export function PartnerMerchantItem({ merchant }: Props) {
  return (
    <li className="border-line flex flex-col gap-4 border-b py-12">
      <p className="text-14 font-medium">
        <span className="font-mono">{merchant.tenantId}</span>{' '}
        <span className="text-text-3 font-normal">
          {merchant.tierName}, {merchant.network}
        </span>
      </p>
      <p className="text-13">{STATUS_TEXT[merchant.status]}</p>
      <p className="text-13 text-text-2">
        {merchant.paidUntil === undefined
          ? 'No paid time of its own'
          : `Its own paid time until ${shownTime(merchant.paidUntil)}`}
      </p>
      <p className="text-13 text-text-2">
        {merchant.volume === undefined ? (
          'Its orders cannot be read right now'
        ) : (
          <VolumeText volume={merchant.volume} />
        )}
      </p>
    </li>
  );
}
