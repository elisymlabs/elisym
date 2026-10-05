import { useEffect, useRef, useState } from 'preact/hooks';
import { PURCHASE_STATUS_LABELS, type Purchase } from '../history';
import { ReceiptBlock } from './ReceiptBlock';

interface Props {
  /** The purchase as the list read it: shown at once. */
  purchase: Purchase;
  /** The purchase as it stands now, its sent transaction checked on chain. */
  fresh(orderId: string): Promise<Purchase | undefined>;
  onBack(): void;
}

function kindOf(purchase: Purchase): 'delivered' | 'refunded' | 'open' {
  if (purchase.status === 'delivered' || purchase.status === 'refunded') {
    return purchase.status;
  }
  return 'open';
}

/**
 * One purchase, inside the fixed "Your purchases" box: its status and its
 * receipt. Drawn from the list's read, then from the record read again (an
 * order completed since shows as completed); a sent transaction appears only
 * after its chain check, and a check that ends after the detail closed draws
 * nothing.
 */
export function PurchaseDetail({ purchase, fresh, onBack }: Props) {
  const [shown, setShown] = useState<Purchase>(purchase);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (document.hasFocus()) {
      back.current?.focus({ preventScroll: true });
    }
  }, []);
  useEffect(() => {
    let open = true;
    void fresh(purchase.orderId)
      .then((now) => {
        if (open && now !== undefined) {
          setShown(now);
        }
      })
      .catch(() => undefined);
    return () => {
      open = false;
    };
  }, [purchase.orderId, fresh]);
  const kind = kindOf(shown);
  return (
    <div class="purchase-detail">
      <button type="button" class="link-button" ref={back} onClick={onBack}>
        Back to the list
      </button>
      <p class="purchase-status">{PURCHASE_STATUS_LABELS[shown.status]}</p>
      {kind === 'open' && !shown.thisProduct ? (
        <p class="note">Open this product's checkout to follow it.</p>
      ) : null}
      <ReceiptBlock receipt={shown.receipt} kind={kind} />
    </div>
  );
}
