import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PURCHASE_STATUS_LABELS, type Purchase, csvFileName, purchasesCsv } from '../history';
import { PurchaseDetail } from './PurchaseDetail';
import { StepHeading } from './StepHeading';
import { paidLine, receiptField } from './text';

/** Where "Your purchases" reads from: the session, read only. */
export interface PurchasesSource {
  purchases(): Promise<Purchase[]>;
  /** One purchase as it stands now (its sent transaction checked on chain), or nothing. */
  purchase(orderId: string): Promise<Purchase | undefined>;
}

interface Props {
  source: PurchasesSource;
  /** The store's name, for the export's file name. */
  storeName?: string;
  onBack(): void;
}

/** A downloaded file's URL is let go this long after the click (never at once: that can cancel it). */
export const REVOKE_DOWNLOAD_AFTER_MS = 30_000;

/** What a read of the purchases that failed resolves to (distinct from an empty history). */
const READ_FAILED = 'failed';

export const READ_FAILED_TEXT = 'Your purchases could not be read here.';

/** Always shown next to the export, whatever is in it. */
export const EXPORT_WARNING = 'The file contains your delivery links. Keep it private.';

/** Hand the buyer a file, from the frame's own origin. */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DOWNLOAD_AFTER_MS);
}

/**
 * "Your purchases": this store's payments in this browser. The box keeps one
 * fixed height whatever it holds (loading, none, many, one opened), and every
 * control around it is always the same, so the frame's height says nothing of
 * the history. It is drawn at once on the click; the records fill it later.
 */
export function PurchasesStep({ source, storeName, onBack }: Props) {
  // A failed read is `failed`, never an empty history: nothing is listed or saved then.
  const [pending] = useState(() => source.purchases().catch((): typeof READ_FAILED => READ_FAILED));
  const [list, setList] = useState<Purchase[] | typeof READ_FAILED | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void pending.then((read) => {
      if (mounted.current) {
        setList(read);
      }
    });
    return () => {
      mounted.current = false;
    };
  }, [pending]);

  /** The row that was opened, focused again on Back to the list. */
  const returnTo = useRef<string | undefined>(undefined);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const orderId = returnTo.current;
    if (opened !== undefined || orderId === undefined || !document.hasFocus()) {
      return;
    }
    returnTo.current = undefined;
    const row = region.current?.querySelector<HTMLElement>(`[data-order="${CSS.escape(orderId)}"]`);
    (row ?? region.current)?.focus({ preventScroll: true });
  }, [opened]);

  const download = async () => {
    // The same read as the list: a click while it loads exports what it finds.
    // Accepted: a very slow read may outlast the click's user activation, and a
    // browser may then hold the download back (checked in the live smoke).
    const read = await pending;
    if (read === READ_FAILED) {
      return;
    }
    saveFile(csvFileName(storeName, new Date()), purchasesCsv(read));
  };

  const detail =
    opened === undefined || list === undefined || list === READ_FAILED
      ? undefined
      : list.find((each) => each.orderId === opened);
  let content: ComponentChildren;
  if (list === undefined) {
    content = (
      <p class="status" role="status">
        Loading…
      </p>
    );
  } else if (list === READ_FAILED) {
    content = (
      <p class="note" role="status">
        {READ_FAILED_TEXT}
      </p>
    );
  } else if (detail !== undefined) {
    content = (
      <PurchaseDetail
        purchase={detail}
        fresh={source.purchase}
        onBack={() => {
          returnTo.current = detail.orderId;
          setOpened(undefined);
        }}
      />
    );
  } else if (list.length === 0) {
    content = <p class="note">No purchases from this store in this browser yet.</p>;
  } else {
    content = (
      <ul class="purchase-list">
        {list.map((purchase) => (
          <li key={purchase.orderId}>
            <button
              type="button"
              class="purchase-row"
              data-order={purchase.orderId}
              onClick={() => setOpened(purchase.orderId)}
            >
              <span class="purchase-date">
                {new Date(purchase.createdAt * 1000).toLocaleDateString()}
              </span>
              <span class="purchase-product">{receiptField(purchase.receipt.product)}</span>
              {purchase.receipt.paying === undefined ? null : (
                <span class="purchase-amount">{paidLine(purchase.receipt.paying)}</span>
              )}
              <span class="purchase-state">{PURCHASE_STATUS_LABELS[purchase.status]}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div class="step purchases" data-step="purchases">
      <StepHeading>Your purchases</StepHeading>
      <div class="purchases-region" data-purchases-region="" tabindex={-1} ref={region}>
        {content}
      </div>
      <button type="button" class="secondary" onClick={() => void download()}>
        Download CSV
      </button>
      <p class="note">{EXPORT_WARNING}</p>
      <button type="button" class="secondary" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
