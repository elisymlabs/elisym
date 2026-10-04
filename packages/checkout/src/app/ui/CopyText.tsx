import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { isTouchOnly } from './device';

interface Props {
  text: string;
  /** The button's name ("Copy", "Copy receipt"). */
  label?: string;
  /** Said once the clipboard took it. */
  copiedText?: string;
  /** The shown block's class. */
  textClass?: string;
  /**
   * What is shown instead of `text` (a shortened, linked form). When the
   * clipboard is refused, the exact `text` replaces it visibly and is selected.
   */
  shown?: ComponentChildren;
}

/** How long the button says "Copied" (or how to copy the selection) before its name returns. */
export const COPIED_FOR_MS = 2000;

type Outcome = 'copied' | 'selected';

/** How a buyer copies the selected text themselves: shown in the button, and announced. */
function selectedHint(): { label: string; announcement: string } {
  if (isTouchOnly(navigator.userAgent, navigator.maxTouchPoints)) {
    return { label: 'Text selected', announcement: 'Text selected: copy it from the menu.' };
  }
  const keys = /Mac/.test(navigator.userAgent) ? 'Press ⌘C' : 'Press Ctrl+C';
  return { label: keys, announcement: `Selected: ${keys} to copy it.` };
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
  textClass = 'delivery',
  shown,
}: Props) {
  const box = useRef<HTMLParagraphElement>(null);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  /** The full text shown in place of `shown`, once the clipboard was refused. */
  const [revealed, setRevealed] = useState(false);
  const pendingSelect = useRef(false);
  const [said, setSaid] = useState('');
  const timers = useRef<{ reset?: number; say?: number }>({});
  useEffect(
    () => () => {
      window.clearTimeout(timers.current.reset);
      window.clearTimeout(timers.current.say);
    },
    [],
  );
  const show = (next: Outcome, message: string) => {
    setOutcome(next);
    // Cleared now and set on the next tick: the same message twice is announced twice.
    setSaid('');
    window.clearTimeout(timers.current.say);
    timers.current.say = window.setTimeout(() => setSaid(message), 0);
    window.clearTimeout(timers.current.reset);
    timers.current.reset = window.setTimeout(() => setOutcome(undefined), COPIED_FOR_MS);
  };
  const selectBox = () => {
    const node = box.current;
    const selection = window.getSelection();
    if (node !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  // The full text is rendered on the next paint: select it once it is there.
  useEffect(() => {
    if (revealed && pendingSelect.current) {
      pendingSelect.current = false;
      selectBox();
    }
  }, [revealed]);
  const select = () => {
    if (shown !== undefined && !revealed) {
      pendingSelect.current = true;
      setRevealed(true);
    } else {
      selectBox();
    }
    show('selected', selectedHint().announcement);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      show('copied', copiedText);
    } catch {
      select();
    }
  };
  const labels: { key: 'idle' | Outcome; text: string }[] = [
    { key: 'idle', text: label },
    { key: 'copied', text: '✓ Copied' },
    { key: 'selected', text: selectedHint().label },
  ];
  const current = outcome ?? 'idle';
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
          {labels.map((entry) => (
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
