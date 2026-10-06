import { copyLabels, useCopy } from './copy';
import { PURCHASES_TEXT } from './text';

interface Props {
  /** The whole receipt as plain text: what is copied. */
  text: string;
}

/**
 * "Copy receipt" as a small text button. A refused clipboard shows the full
 * receipt under it and selects it: the only time the card grows, inside the
 * scrolling box.
 */
export function CopyReceiptButton({ text }: Props) {
  const { copy, current, revealed, box, said } = useCopy<HTMLParagraphElement>({
    text,
    copiedText: PURCHASES_TEXT.receiptCopied,
    hasShortForm: true,
  });
  return (
    <div class="purchase-copy">
      <button type="button" class="text-button" onClick={() => void copy()}>
        <span class="label-stack">
          {copyLabels(PURCHASES_TEXT.copyReceipt).map((entry) => (
            <span key={entry.key} class="label-option" data-current={entry.key === current}>
              {entry.text}
            </span>
          ))}
        </span>
      </button>
      {revealed ? (
        <p class="purchase-receipt-full" ref={box}>
          {text}
        </p>
      ) : null}
      <span class="visually-hidden" role="status">
        {said}
      </span>
    </div>
  );
}
