import { useId } from 'preact/hooks';
import { useCopy } from './copy';
import { CopyIcon } from './CopyIcon';
import { PURCHASES_TEXT, receiptField, shortId } from './text';

interface Props {
  orderId: string;
}

/**
 * The shortened order id and its icon form one copy target. A refused
 * clipboard shows the full id in place and selects it.
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
      <button
        type="button"
        class="order-copy"
        aria-label={PURCHASES_TEXT.copyOrder}
        title={PURCHASES_TEXT.copyOrder}
        aria-describedby={help}
        onClick={() => void copy()}
      >
        <span class="mono" title={`${full}. ${PURCHASES_TEXT.orderHelp}`} ref={box}>
          {revealed ? full : shortId(full)}
        </span>
        <span class="label-stack" aria-hidden="true">
          <span class="label-option" data-current={current !== 'copied'}>
            <CopyIcon />
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
