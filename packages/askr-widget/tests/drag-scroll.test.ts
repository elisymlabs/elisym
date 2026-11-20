// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAG_THRESHOLD_PX, enableDragScroll } from '../src/ui/drag-scroll';

function pointer(
  type: string,
  clientX: number,
  init: { pointerType?: string; buttons?: number } = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: init.pointerType ?? 'mouse',
    button: 0,
    buttons: init.buttons ?? (type === 'pointerup' ? 0 : 1),
    clientX,
  });
}

function row(): { box: HTMLElement; link: HTMLAnchorElement; clicked: () => number } {
  const box = document.createElement('div');
  const card = document.createElement('div');
  const link = document.createElement('a');
  link.href = 'https://shop.example/p';
  card.append(link);
  box.append(card);
  document.body.append(box);
  let clicks = 0;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    clicks += 1;
  });
  box.setPointerCapture = () => undefined;
  box.releasePointerCapture = () => undefined;
  box.hasPointerCapture = () => false;
  box.scrollTo = (() => undefined) as typeof box.scrollTo;
  enableDragScroll(box);
  return { box, link, clicked: () => clicks };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('dragging a card row with the mouse', () => {
  it('scrolls the row with the pointer, stays where released, and swallows the click', () => {
    const { box, link, clicked } = row();
    const scrollTo = vi.fn();
    box.scrollTo = scrollTo as typeof box.scrollTo;
    box.scrollLeft = 100;
    link.dispatchEvent(pointer('pointerdown', 300));
    // Crossing the threshold starts the drag without a jump.
    link.dispatchEvent(pointer('pointermove', 290));
    expect(box.classList.contains('dragging')).toBe(true);
    expect(box.scrollLeft).toBe(100);
    link.dispatchEvent(pointer('pointermove', 247));
    expect(box.scrollLeft).toBe(143);
    link.dispatchEvent(pointer('pointerup', 247));
    expect(box.classList.contains('dragging')).toBe(false);
    // No snap to a card on release: the row stays where the pointer left it.
    expect(box.scrollLeft).toBe(143);
    expect(scrollTo).not.toHaveBeenCalled();
    link.click();
    expect(clicked()).toBe(0);
  });

  it('a press that barely moves is still a click', () => {
    const { link, box, clicked } = row();
    link.dispatchEvent(pointer('pointerdown', 300));
    link.dispatchEvent(pointer('pointermove', 300 - (DRAG_THRESHOLD_PX - 1)));
    link.dispatchEvent(pointer('pointerup', 300 - (DRAG_THRESHOLD_PX - 1)));
    expect(box.classList.contains('dragging')).toBe(false);
    link.click();
    expect(clicked()).toBe(1);
  });

  it('a click after the drag has settled goes through', () => {
    vi.useFakeTimers();
    const { link, clicked } = row();
    link.dispatchEvent(pointer('pointerdown', 300));
    link.dispatchEvent(pointer('pointermove', 200));
    link.dispatchEvent(pointer('pointerup', 200));
    vi.runAllTimers();
    link.click();
    expect(clicked()).toBe(1);
  });

  it('touch keeps the browser scrolling, and a released button ends the press', () => {
    const { box, link } = row();
    link.dispatchEvent(pointer('pointerdown', 300, { pointerType: 'touch' }));
    link.dispatchEvent(pointer('pointermove', 200, { pointerType: 'touch' }));
    expect(box.classList.contains('dragging')).toBe(false);
    link.dispatchEvent(pointer('pointerdown', 300));
    // Released outside the row: the next move has no button down and drags nothing.
    link.dispatchEvent(pointer('pointermove', 200, { buttons: 0 }));
    expect(box.classList.contains('dragging')).toBe(false);
  });

  it('no image or link starts a native drag', () => {
    const { link } = row();
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    link.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });
});
