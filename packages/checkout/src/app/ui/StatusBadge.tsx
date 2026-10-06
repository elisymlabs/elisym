import { PURCHASE_STATUS_LABELS, type PurchaseStatus } from '../history';
import { PURCHASE_BADGES } from './text';

interface Props {
  status: PurchaseStatus;
}

/** A purchase's status, short; its full label in `title` when the badge says less. */
export function StatusBadge({ status }: Props) {
  const { text, tone } = PURCHASE_BADGES[status];
  const label = PURCHASE_STATUS_LABELS[status];
  return (
    <span class="status-badge" data-tone={tone} {...(label === text ? {} : { title: label })}>
      {text}
    </span>
  );
}
