import { useRef, useState } from 'preact/hooks';

interface Props {
  text: string;
}

/**
 * A text delivery with a Copy button. A v1 frame has no clipboard permission,
 * so a refused write falls back to selecting the text for the buyer to copy.
 */
export function CopyText({ text }: Props) {
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
      <p class="delivery" ref={box}>
        {text}
      </p>
      <button type="button" class="secondary" onClick={() => void copy()}>
        Copy
      </button>
      {outcome === undefined ? null : (
        <p class="note" role="status">
          {outcome === 'copied' ? 'Copied.' : 'Selected: copy it with your keyboard or menu.'}
        </p>
      )}
    </div>
  );
}
