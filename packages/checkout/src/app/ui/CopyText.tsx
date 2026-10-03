import { useRef, useState } from 'preact/hooks';

interface Props {
  text: string;
  /** The button's name ("Copy", "Copy receipt"). */
  label?: string;
  /** Said once the clipboard took it. */
  copiedText?: string;
  /** The shown block's class: it is exactly what is copied, and what is selected. */
  textClass?: string;
}

/**
 * A text with a Copy button. A v1 frame has no clipboard permission, so a
 * refused write falls back to selecting the shown text for the buyer to copy.
 */
export function CopyText({
  text,
  label = 'Copy',
  copiedText = 'Copied.',
  textClass = 'delivery',
}: Props) {
  const box = useRef<HTMLParagraphElement>(null);
  const [outcome, setOutcome] = useState<'copied' | 'selected' | undefined>(undefined);
  const select = () => {
    const node = box.current;
    const selection = window.getSelection();
    if (node !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setOutcome('selected');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setOutcome('copied');
    } catch {
      select();
    }
  };
  return (
    <div class="copy">
      <p class={textClass} ref={box}>
        {text}
      </p>
      <button type="button" class="secondary" onClick={() => void copy()}>
        {label}
      </button>
      {outcome === undefined ? null : (
        <p class="note" role="status">
          {outcome === 'copied' ? copiedText : 'Selected: copy it with your keyboard or menu.'}
        </p>
      )}
    </div>
  );
}
