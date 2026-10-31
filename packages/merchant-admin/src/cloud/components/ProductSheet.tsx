import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';

interface Props {
  /** The heading: the product's title, or what it is while it has none. */
  title: string;
  /** Changed since the sheet opened: closing it asks first. */
  changed: boolean;
  /** Closes it, keeping nothing of what changed since it opened. */
  onDiscard: () => void;
  /** Closes it with nothing to discard. */
  onClose: () => void;
  /** The footer's actions (save, remove). */
  actions: ReactNode;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One product in a side sheet: a modal dialog named by its heading. Focus
 * stays inside it; Escape and Close ask before throwing away what changed
 * since it opened. The page behind it is inert while it is open.
 */
export function ProductSheet({ title, changed, onDiscard, onClose, actions, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);

  // The first field takes the focus when the sheet opens.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, []);
  useEffect(() => {
    if (asking) {
      keep.current?.focus();
    }
  }, [asking]);

  const close = () => {
    if (changed) {
      setAsking(true);
    } else {
      onClose();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (asking) {
        setAsking(false);
      } else {
        close();
      }
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) {
      return;
    }
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div aria-hidden="true" className="bg-bg/70 absolute inset-0" onClick={close} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-sheet-title"
        onKeyDown={onKeyDown}
        className="border-line bg-surface relative flex h-full w-full max-w-560 flex-col border-l shadow-xl"
      >
        <div className="border-line flex items-center justify-between gap-12 border-b px-20 py-16">
          <h2 id="product-sheet-title" className="text-18 truncate font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-8 text-text-2 hover:bg-surface-2 hover:text-text grid size-32 place-items-center"
          >
            <Icon name="close" className="size-18" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-20 py-20">{children}</div>
        <div className="border-line flex flex-col gap-12 border-t px-20 py-16">
          {asking ? (
            <div
              role="alertdialog"
              aria-labelledby="product-sheet-asking"
              className="flex flex-col gap-12"
            >
              <p id="product-sheet-asking" className="text-14">
                Throw away your changes to this product?
              </p>
              <div className="flex flex-wrap gap-8">
                <Button ref={keep} onClick={() => setAsking(false)}>
                  Keep editing
                </Button>
                <Button onClick={onDiscard}>Discard changes</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-8">{actions}</div>
          )}
        </div>
      </div>
    </div>
  );
}
