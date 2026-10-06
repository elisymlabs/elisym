import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { isTouchOnly } from './device';

/** How long a copy control says "Copied" (or how to copy the selection) before its name returns. */
export const COPIED_FOR_MS = 2000;

export type CopyOutcome = 'copied' | 'selected';

/** How a buyer copies the selected text themselves: shown in the button, and announced. */
export function selectedHint(): { label: string; announcement: string } {
  if (isTouchOnly(navigator.userAgent, navigator.maxTouchPoints)) {
    return { label: 'Text selected', announcement: 'Text selected: copy it from the menu.' };
  }
  const keys = /Mac/.test(navigator.userAgent) ? 'Press ⌘C' : 'Press Ctrl+C';
  return { label: keys, announcement: `Selected: ${keys} to copy it.` };
}

/** A copy button's labels, all in one cell: its name, "Copied", and how to copy the selection. */
export function copyLabels(label: string): { key: 'idle' | CopyOutcome; text: string }[] {
  return [
    { key: 'idle', text: label },
    { key: 'copied', text: '✓ Copied' },
    { key: 'selected', text: selectedHint().label },
  ];
}

interface Options {
  text: string;
  /** Said once the clipboard took it. */
  copiedText: string;
  /** A shortened form is shown in place of `text`: a refused write reveals the full text first. */
  hasShortForm: boolean;
}

interface Copy<Box extends HTMLElement> {
  copy(): Promise<void>;
  current: 'idle' | CopyOutcome;
  /** The full text is shown in place of the short form, once the clipboard was refused. */
  revealed: boolean;
  /** The element whose text is selected when the clipboard is refused. */
  box: RefObject<Box>;
  /** What the hidden live region says now. */
  said: string;
}

/**
 * Copy a text, or select it for the buyer: a v1 frame has no clipboard
 * permission, so a refused write falls back to selecting the copied text. When
 * a shortened form is shown, the full text replaces it first (`revealed`), so
 * what is selected is visible. The outcome is announced once per copy.
 */
export function useCopy<Box extends HTMLElement>({
  text,
  copiedText,
  hasShortForm,
}: Options): Copy<Box> {
  const box = useRef<Box>(null);
  const [outcome, setOutcome] = useState<CopyOutcome | undefined>(undefined);
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
  const show = (next: CopyOutcome, message: string) => {
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
    if (hasShortForm && !revealed) {
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
  return { copy, current: outcome ?? 'idle', revealed, box, said };
}
