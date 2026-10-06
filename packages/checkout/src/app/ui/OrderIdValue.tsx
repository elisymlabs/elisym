import { useId } from 'preact/hooks';
import { useCopy } from './copy';
import { PURCHASES_TEXT, receiptField, shortId } from './text';

interface Props {
  orderId: string;
}

/**
 * An order id, shortened, with an icon that copies all of it. What it is for
 * is said to screen readers (the icon's description) and on hover, not on
 * screen. A refused clipboard shows the full id in place and selects it.
 */
export function OrderIdValue({ orderId }: Props) {
  const full = receiptField(orderId);
  const help = useId();
  const { copy, current, revealed, box, said } = useCopy<HTMLSpanElement>({
    text: full,
    copiedText: PURCHASES_TEXT.orderCopied,
    hasShortForm: true,
  });
  return (
    <span class="order-id">
      <span class="mono" title={`${full}. ${PURCHASES_TEXT.orderHelp}`} ref={box}>
        {revealed ? full : shortId(full)}
      </span>
      <button
        type="button"
        class="icon-button"
        aria-label={PURCHASES_TEXT.copyOrder}
        title={PURCHASES_TEXT.copyOrder}
        aria-describedby={help}
        onClick={() => void copy()}
      >
        <span class="label-stack" aria-hidden="true">
          <span class="label-option" data-current={current !== 'copied'}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
            </svg>
          </span>
          <span class="label-option" data-current={current === 'copied'}>
            ✓
          </span>
        </span>
      </button>
      <span class="visually-hidden" id={help}>
        {PURCHASES_TEXT.orderHelp}
      </span>
      <span class="visually-hidden" role="status">
        {said}
      </span>
    </span>
  );
}
