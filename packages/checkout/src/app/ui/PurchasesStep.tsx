import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Purchase, csvFileName, purchasesCsv } from '../history';
import { PurchaseDetail } from './PurchaseDetail';
import { PurchaseRow } from './PurchaseRow';
import { StepHeading } from './StepHeading';
import { PURCHASES_TEXT } from './text';

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
  /** Dev only (the fixture page): this purchase starts opened. */
  initialOpened?: string;
}

/** A downloaded file's URL is let go this long after the click (never at once: that can cancel it). */
export const REVOKE_DOWNLOAD_AFTER_MS = 30_000;

/** What a read of the purchases that failed resolves to (distinct from an empty history). */
const READ_FAILED = 'failed';

export const READ_FAILED_TEXT = 'Your purchases could not be read here.';

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
 * fixed height whatever it holds (loading, none, many, one opened), and its
 * navigation and actions live inside it, so the markup around it never changes
 * and the frame's height says nothing of the history. It is drawn at once on
 * the click; the records fill it later.
 */
export function PurchasesStep({ source, storeName, onBack, initialOpened }: Props) {
  // A failed read is `failed`, never an empty history: nothing is listed or saved then.
  const [pending] = useState(() => source.purchases().catch((): typeof READ_FAILED => READ_FAILED));
  const [list, setList] = useState<Purchase[] | typeof READ_FAILED | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(initialOpened);
  /** The row that was opened, focused again on the way back to the list. */
  const returnTo = useRef<string | undefined>(undefined);
  const region = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  /** The export button had focus when the read failed: its removal hands focus to the note. */
  const refocusFailed = useRef(false);
  const failedNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    void pending.then((read) => {
      if (mounted.current) {
        const actions = region.current?.querySelector('.purchases-actions');
        refocusFailed.current =
          read === READ_FAILED && actions?.contains(document.activeElement) === true;
        setList(read);
      }
    });
    return () => {
      mounted.current = false;
    };
  }, [pending]);

  const loaded = list !== undefined;
  useEffect(() => {
    if (!document.hasFocus()) {
      return;
    }
    if (opened !== undefined) {
      // A purchase opened before the list is read (the fixture page) is not drawn yet.
      if (!loaded) {
        return;
      }
      region.current
        ?.querySelector<HTMLElement>('[data-purchases-back]')
        ?.focus({ preventScroll: true });
      return;
    }
    const orderId = returnTo.current;
    if (orderId === undefined) {
      return;
    }
    returnTo.current = undefined;
    const row = region.current?.querySelector<HTMLElement>(`[data-order="${CSS.escape(orderId)}"]`);
    (row ?? region.current)?.focus({ preventScroll: true });
  }, [opened, loaded]);
  useEffect(() => {
    if (!refocusFailed.current) {
      return;
    }
    refocusFailed.current = false;
    if (document.hasFocus()) {
      failedNote.current?.focus({ preventScroll: true });
    }
  }, [list]);

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
  let nav: ComponentChildren;
  if (detail === undefined) {
    nav = (
      <>
        <button
          type="button"
          class="icon-button"
          data-purchases-back=""
          aria-label={PURCHASES_TEXT.backToCheckout}
          title={PURCHASES_TEXT.backToCheckout}
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
        </button>
        <StepHeading>{PURCHASES_TEXT.title}</StepHeading>
      </>
    );
  } else {
    nav = (
      <button
        type="button"
        class="nav-back"
        data-purchases-back=""
        aria-label={PURCHASES_TEXT.backToListLabel}
        onClick={() => {
          returnTo.current = detail.orderId;
          setOpened(undefined);
        }}
      >
        <span aria-hidden="true">←</span> {PURCHASES_TEXT.backToList}
      </button>
    );
  }
  let content: ComponentChildren;
  if (list === undefined) {
    content = (
      <p class="status" role="status">
        {PURCHASES_TEXT.loading}
      </p>
    );
  } else if (list === READ_FAILED) {
    content = (
      <p class="note" role="status" tabindex={-1} ref={failedNote}>
        {READ_FAILED_TEXT}
      </p>
    );
  } else if (detail !== undefined) {
    content = <PurchaseDetail purchase={detail} fresh={source.purchase} />;
  } else if (list.length === 0) {
    content = <p class="note">{PURCHASES_TEXT.empty}</p>;
  } else {
    content = (
      <ul class="purchase-list">
        {list.map((purchase) => (
          <PurchaseRow key={purchase.orderId} purchase={purchase} onOpen={setOpened} />
        ))}
      </ul>
    );
  }

  return (
    <div class="step purchases" data-step="purchases">
      <div class="purchases-region" data-purchases-region="" tabindex={-1} ref={region}>
        <div class="purchases-nav">{nav}</div>
        <div class="purchases-body">{content}</div>
        {detail === undefined && list !== READ_FAILED ? (
          <div class="purchases-actions">
            <button type="button" class="text-button" onClick={() => void download()}>
              {PURCHASES_TEXT.downloadCsv}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
