// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { StoreCheckDeps } from '../src/store-check';

const calls = vi.hoisted(() => ({ deps: [] as unknown[] }));
vi.mock('../src/store-check', () => ({
  checkStore: vi.fn(async (_owner: string, deps: unknown) => {
    calls.deps.push(deps);
    return 'show';
  }),
}));

describe('checkBrowserStore', () => {
  it('checks against the real relay and gateway and keeps its decision in sessionStorage', async () => {
    const { checkBrowserStore } = await import('../src/browser-client');
    const { connectNostrRelay } = await import('../src/relay');
    expect(await checkBrowserStore('a'.repeat(64))).toBe('show');
    const [deps] = calls.deps as StoreCheckDeps[];
    expect(deps?.connect).toBe(connectNostrRelay);
    expect(typeof deps?.gateway.openSession).toBe('function');
    expect(deps?.storage).toBe(window.sessionStorage);
  });
});
