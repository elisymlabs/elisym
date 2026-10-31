import { shownAmount } from '../lib/orders';
import type { Volume } from '../lib/partner';

interface Props {
  volume: Volume;
}

/** Paid orders and what they paid, per asset. */
export function VolumeText({ volume }: Props) {
  const amounts = volume.paid.map(([asset, amount]) => shownAmount(amount, asset));
  return (
    <>
      {volume.orders === 1 ? '1 paid order' : `${volume.orders} paid orders`}
      {amounts.length === 0 ? null : `: ${amounts.join(', ')}`}
    </>
  );
}
