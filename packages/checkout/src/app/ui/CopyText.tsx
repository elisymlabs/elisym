import type { ComponentChildren } from 'preact';
import { copyLabels, useCopy } from './copy';

export { COPIED_FOR_MS } from './copy';

interface Props {
  text: string;
  /** The button's name ("Copy", "Copy receipt"). */
  label?: string;
  /** Said once the clipboard took it. */
  copiedText?: string;
  /** The shown block's class. */
  textClass: string;
  /**
   * What is shown instead of `text` (a shortened, linked form). When the
   * clipboard is refused, the exact `text` replaces it visibly and is selected.
   */
  shown?: ComponentChildren;
}

/**
 * A text with a Copy button. A v1 frame has no clipboard permission, so a
 * refused write falls back to selecting the copied text for the buyer to copy:
 * when a shortened form is shown, the full text replaces it first (the only
 * case where the block may grow), so what is selected is visible.
 * The outcome shows in the button itself (all its labels share one cell, so
 * nothing moves) and is announced by a hidden live region.
 */
export function CopyText({
  text,
  label = 'Copy',
  copiedText = 'Copied.',
  textClass,
  shown,
}: Props) {
  const { copy, current, revealed, box, said } = useCopy<HTMLParagraphElement>({
    text,
    copiedText,
    hasShortForm: shown !== undefined,
  });
  return (
    <div class="copy">
      {shown === undefined || revealed ? (
        <p class={textClass} ref={box}>
          {text}
        </p>
      ) : (
        <div class={textClass}>{shown}</div>
      )}
      <button type="button" class="secondary copy-button" onClick={() => void copy()}>
        <span class="label-stack">
          {copyLabels(label).map((entry) => (
            <span key={entry.key} class="label-option" data-current={entry.key === current}>
              {entry.text}
            </span>
          ))}
        </span>
      </button>
      <span class="visually-hidden" role="status">
        {said}
      </span>
    </div>
  );
}
