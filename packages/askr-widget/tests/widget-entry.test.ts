// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

// The entry script, with the browser wiring replaced: it must hand the element the store check.
const wiring = vi.hoisted(() => ({
  checkBrowserStore: vi.fn(async (_owner: string) => ({ visibility: 'hide' as const })),
  createBrowserClient: vi.fn(),
}));
vi.mock('../src/browser-client', () => wiring);

describe('widget.js', () => {
  it('defines <askr-chat> with the browser store check, so a pending store shows nothing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await import('../src/widget');
    const owner = 'a'.repeat(64);
    const widget = document.createElement('askr-chat');
    widget.setAttribute('store', owner);
    document.body.append(widget);
    expect(wiring.checkBrowserStore).toHaveBeenCalledWith(owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(widget.shadowRoot?.childNodes).toHaveLength(0);
    expect(wiring.createBrowserClient).not.toHaveBeenCalled();
  });
});
