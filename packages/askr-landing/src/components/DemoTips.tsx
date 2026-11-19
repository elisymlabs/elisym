import { type PointerEvent, type ReactNode, useRef, useState } from 'react';

/** What the tip says over a control that only looks like it works. */
export const DEMO_TIP = 'Just a demo. Add Askr to your store to try it live.';

interface Tip {
  left: number;
  top: number;
  /** The drawing's width: the tip stays inside it, whatever control it points at. */
  width: number;
}

/** Space kept between the tip and the drawing's edges. */
const EDGE = 8;

interface Props {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps a drawing of the widget. Pointing at one of its controls (anything marked `data-demo`)
 * shows a small tip above it saying it is a demo, so a dead button does not puzzle anyone. The
 * tip is drawn over the whole drawing, never clipped by a card or a scroll row.
 */
export function DemoTips({ children, className = '' }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | undefined>(undefined);

  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    const control = event.target instanceof Element ? event.target.closest('[data-demo]') : null;
    if (box === null || control === null) {
      setTip(undefined);
      return;
    }
    const area = box.getBoundingClientRect();
    const place = control.getBoundingClientRect();
    setTip({
      left: place.left + place.width / 2 - area.left,
      top: place.top - area.top,
      width: area.width,
    });
  };

  return (
    <div
      ref={boxRef}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setTip(undefined)}
      className={`relative ${className}`}
    >
      {children}
      {tip !== undefined && <DemoTipBubble {...tip} />}
    </div>
  );
}

/** The bubble itself, centred above the point it is given, but never past the drawing's edges. */
function DemoTipBubble({ left, top, width }: Tip) {
  // Placed through the CSSOM (allowed by the page's CSP), not a style attribute.
  const place = (element: HTMLDivElement | null) => {
    if (element !== null) {
      const half = element.offsetWidth / 2;
      const centre = Math.max(half + EDGE, Math.min(width - half - EDGE, left));
      element.style.left = `${centre}px`;
      element.style.top = `${top}px`;
    }
  };
  return (
    <div
      ref={place}
      aria-hidden="true"
      className="demo-tip bg-ink text-on-ink text-12 rounded-8 pointer-events-none absolute z-20 w-max max-w-240 px-12 py-6 text-center leading-snug font-medium shadow-[0_8px_24px_-8px_rgb(18_19_22/0.5)]"
    >
      {DEMO_TIP}
    </div>
  );
}
