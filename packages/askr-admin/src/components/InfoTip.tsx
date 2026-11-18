import { useEffect, useId, useRef, useState } from 'react';
import { type Help, helpUrl } from '../lib/help';

/** The panel's width (`w-280`), the room it keeps from an edge, and its narrowing on a phone. */
const PANEL_WIDTH = 280;
const EDGE_GAP = 16;
const NARROW_MARGIN = 48;

/**
 * How far the panel's left edge sits from the button's (px): none when it fits, else moved left
 * just enough to end before the right edge, and never past the left one.
 */
export function panelShift(buttonLeft: number, rightEdge: number, windowWidth: number): number {
  const width = Math.min(PANEL_WIDTH, windowWidth - NARROW_MARGIN);
  const overflow = buttonLeft + width - (rightEdge - EDGE_GAP);
  return Math.max(Math.min(0, -overflow), EDGE_GAP - buttonLeft);
}

interface Props {
  help: Help;
  /** What it explains, for the button's accessible name: "About Store name". */
  about: string;
}

/**
 * An "i" button that opens a short explanation with a link to the guide. A press
 * opens and closes it; Escape or a press elsewhere closes it.
 */
export function InfoTip({ help, about }: Props) {
  const [open, setOpen] = useState(false);
  /** Opened near an edge, the panel moves along so that it stays on screen. */
  const [shift, setShift] = useState(0);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target) !== true) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        // Focus comes back only from inside the tip, never from a field the visitor moved to.
        if (box.current?.contains(document.activeElement) === true) {
          button.current?.focus();
        }
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-flex align-middle">
      <button
        ref={button}
        type="button"
        className="text-text-3 hover:text-text rounded-full transition-colors"
        aria-label={`About ${about}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          const edge = Math.min(
            window.innerWidth,
            box.current?.closest('main')?.getBoundingClientRect().right ?? window.innerWidth,
          );
          const left = box.current?.getBoundingClientRect().left ?? 0;
          setShift(panelShift(left, edge, window.innerWidth));
          setOpen((shown) => !shown);
        }}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-14"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.3v3.6" />
          <path d="M8 5.1h.01" strokeWidth={1.8} />
        </svg>
      </button>
      {open ? (
        <span
          id={panelId}
          role="note"
          style={{ left: shift }}
          className="border-line-2 bg-surface-2 text-13 text-text-2 rounded-10 absolute top-full z-30 mt-6 flex w-280 max-w-[calc(100vw-48px)] flex-col gap-8 border p-12 text-left leading-relaxed font-normal shadow-lg"
        >
          <span>{help.text}</span>
          <a
            className="text-text self-start font-medium underline underline-offset-2"
            href={helpUrl(help)}
            target="_blank"
            rel="noreferrer"
          >
            Read more
          </a>
        </span>
      ) : null}
    </span>
  );
}
