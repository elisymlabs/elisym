/** The part of `window` the first focus uses, so tests can stand in for it. */
export interface FocusWindow {
  addEventListener(type: 'focus' | 'pointerdown' | 'keydown', listener: () => void): void;
  removeEventListener(type: 'focus' | 'pointerdown' | 'keydown', listener: () => void): void;
  document: { hasFocus(): boolean };
}

export interface FirstFocus {
  /** The first offer or refusal is on screen: its heading can take focus. */
  ready(): void;
}

/**
 * In a modal only: the first time the frame gets focus (the loader focuses it
 * on open), move it to the store-name heading, once. Until the heading is on
 * screen, a focus that came is remembered; once it is, the focus moves only if
 * the frame still has it. The buyer's own first click or key disarms it, so a
 * later return from a wallet popup never jumps the sheet.
 */
export function armFirstFocus(self: FocusWindow, focusHeading: () => void): FirstFocus {
  let armed = true;
  let shown = false;
  let focused = false;
  const disarm = () => {
    armed = false;
    self.removeEventListener('focus', onFocus);
    self.removeEventListener('pointerdown', disarm);
    self.removeEventListener('keydown', disarm);
  };
  const onFocus = () => {
    focused = true;
    attempt();
  };
  const attempt = () => {
    if (!armed || !shown) {
      return;
    }
    if (self.document.hasFocus()) {
      disarm();
      focusHeading();
    } else if (focused) {
      // The focus came while loading and is gone now: never pulled back.
      disarm();
    }
  };
  self.addEventListener('focus', onFocus);
  self.addEventListener('pointerdown', disarm);
  self.addEventListener('keydown', disarm);
  return {
    ready: () => {
      if (!shown) {
        shown = true;
        attempt();
      }
    },
  };
}

/** The part of `window` the Escape listener uses. */
export interface KeyWindow {
  addEventListener(type: 'keydown', listener: (event: { key: string }) => void): void;
}

/** In a modal only: Escape inside the frame never reaches the page, so the frame asks it to close. */
export function closeOnEscape(self: KeyWindow, close: () => void): void {
  self.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });
}
