// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderIdValue } from '../src/app/ui/OrderIdValue';

let root: HTMLDivElement;
const full = 'b3a7c2-1234567890-0001';
function mount() {
  root = document.createElement('div');
  document.body.append(root);
  act(() => render(<OrderIdValue orderId={full} />, root));
}
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe('order copy control', () => {
  it('copies the full id from either its shortened text or its icon', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as never);
    mount();
    expect(root.querySelector('.mono')?.textContent).not.toBe(full);
    await act(async () => {
      root
        .querySelector<SVGElement>('.receipt-copy-icon')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => root.querySelector<HTMLElement>('.mono')!.click());
    expect(writeText.mock.calls).toEqual([[full], [full]]);
  });
  it('reveals and selects the full id if clipboard access is refused', async () => {
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      writeText: async () => {
        throw new Error('Clipboard denied');
      },
    } as never);
    mount();
    await act(async () => root.querySelector<HTMLElement>('.mono')!.click());
    expect(root.querySelector('.mono')?.textContent).toBe(full);
    expect(window.getSelection()?.toString()).toBe(full);
  });
});
