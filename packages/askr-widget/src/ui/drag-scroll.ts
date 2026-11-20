/** A press must travel this far (px) before it scrolls the row rather than clicks. */
export const DRAG_THRESHOLD_PX = 6;

/** Controls a mouse press does not drag from: a select opens on the press itself. */
const NO_DRAG_SELECTOR = 'select, input, textarea';

/** Whether the visitor asked for less motion; a host page that breaks `matchMedia` counts as asking. */
function prefersStill(row: HTMLElement): boolean {
  try {
    return (
      row.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
      true
    );
  } catch {
    return true;
  }
}

/** The scroll position that puts the card nearest the row's start edge at that edge. */
function nearestCardScroll(row: HTMLElement): number | undefined {
  const rowLeft = row.getBoundingClientRect().left;
  const style = row.ownerDocument.defaultView?.getComputedStyle(row);
  const inset = Number.parseFloat(style?.scrollPaddingInlineStart ?? '') || 0;
  let best: number | undefined;
  for (const card of row.children) {
    const target = row.scrollLeft + card.getBoundingClientRect().left - rowLeft - inset;
    if (best === undefined || Math.abs(target - row.scrollLeft) < Math.abs(best - row.scrollLeft)) {
      best = target;
    }
  }
  return best;
}

/**
 * Let a mouse scroll a sideways row by pressing and dragging, as a finger already can. Touch and
 * pen keep the browser's own scrolling. A press that moved past the threshold is a drag: the
 * click it would end in (on a link, a choice or the cart button) is swallowed, and the row snaps
 * back to a card once it is released.
 */
export function enableDragScroll(row: HTMLElement): void {
  let pointerId: number | undefined;
  let startX = 0;
  let startScroll = 0;
  let dragging = false;
  let swallowClick = false;

  const finish = (): void => {
    if (pointerId === undefined) {
      return;
    }
    if (row.hasPointerCapture(pointerId)) {
      row.releasePointerCapture(pointerId);
    }
    pointerId = undefined;
    if (dragging) {
      dragging = false;
      swallowClick = true;
      // Snapping off while dragging, so the row followed the pointer; back on, it settles on a card.
      row.classList.remove('dragging');
      const target = nearestCardScroll(row);
      if (target !== undefined) {
        row.scrollTo({ left: target, behavior: prefersStill(row) ? 'auto' : 'smooth' });
      }
      // The click a drag ends in comes right after pointerup; a later one is the visitor's own.
      setTimeout(() => {
        swallowClick = false;
      }, 0);
    }
  };

  row.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest(NO_DRAG_SELECTOR)) {
      return;
    }
    pointerId = event.pointerId;
    startX = event.clientX;
    startScroll = row.scrollLeft;
    dragging = false;
  });
  row.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }
    // Released outside the row before it became a drag: no pointerup reached the row.
    if ((event.buttons & 1) === 0) {
      finish();
      return;
    }
    const moved = event.clientX - startX;
    if (!dragging) {
      if (Math.abs(moved) < DRAG_THRESHOLD_PX) {
        return;
      }
      dragging = true;
      row.classList.add('dragging');
      row.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    row.scrollLeft = startScroll - moved;
  });
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
  row.addEventListener('lostpointercapture', finish);
  row.addEventListener(
    'click',
    (event) => {
      if (swallowClick) {
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  // Images and links would otherwise start the browser's own drag (a ghost image follows the pointer).
  row.addEventListener('dragstart', (event) => {
    event.preventDefault();
  });
}
