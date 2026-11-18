import { useEffect, useId, useRef, useState } from 'react';
import { type Help, helpUrl } from '../lib/help';

/** The panel's width (`w-280`) and the room it keeps from an edge, in px. */
const PANEL_WIDTH = 280;
const EDGE_GAP = 16;

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
  /** Opened near the right edge, the panel hangs to the left of the button instead. */
  const [alignRight, setAlignRight] = useState(false);
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
          setAlignRight(left + PANEL_WIDTH > edge - EDGE_GAP);
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
          className={`${alignRight ? 'right-0' : 'left-0'} border-line-2 bg-surface-2 text-13 text-text-2 rounded-10 absolute top-full z-30 mt-6 flex w-280 max-w-[calc(100vw-48px)] flex-col gap-8 border p-12 text-left leading-relaxed font-normal shadow-lg`}
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
