import { useLayoutEffect, useState } from 'preact/hooks';

/** Matches the dropdown opacity/transform transitions in styles.css. */
export const DROPDOWN_MOTION_MS = 200;

/** Keep an inert panel in the DOM until its exit transition finishes. */
export function useDropdownMotion(open: boolean) {
  const [retained, setRetained] = useState(open);
  const [visible, setVisible] = useState(open);

  useLayoutEffect(() => {
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;
    let timer: number | undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (open) {
      setRetained(true);
      if (retained || reduced) {
        setVisible(true);
      } else {
        firstFrame = window.requestAnimationFrame(() => {
          secondFrame = window.requestAnimationFrame(() => setVisible(true));
        });
      }
    } else {
      setVisible(false);
      if (retained && !reduced) {
        timer = window.setTimeout(() => setRetained(false), DROPDOWN_MOTION_MS);
      } else {
        setRetained(false);
      }
    }
    return () => {
      if (firstFrame !== undefined) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.clearTimeout(timer);
    };
    // Capture presence only when the requested open state changes: reopening an
    // exiting panel reverses the existing transition without remounting it.
  }, [open]);

  return { present: open || retained, visible: open && visible };
}
