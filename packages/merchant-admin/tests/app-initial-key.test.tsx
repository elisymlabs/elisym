import { generateSecretKey } from 'nostr-tools/pure';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { parseStoreKey } from '../src/lib/core';
import { fakeDeps, relayClient } from './fakes';

const signInRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/components/SignIn', () => ({
  SignIn: () => {
    signInRenders.count += 1;
    return null;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('the self-hosted admin opened with a key the sign-in took', () => {
  it('opens it with no second sign-in shown first', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const key = parseStoreKey(Buffer.from(generateSecretKey()).toString('hex'));
    if (key === undefined) {
      throw new Error('no key');
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <App
          ownTab
          createDeps={() =>
            fakeDeps(
              relayClient(() => []),
              [],
            )
          }
          leave={() => undefined}
          initialKey={key}
        />,
      ),
    );
    expect(signInRenders.count).toBe(0);
    // Without a key, the sign-in is what it shows.
    await act(async () =>
      root.render(
        <App
          ownTab
          createDeps={() =>
            fakeDeps(
              relayClient(() => []),
              [],
            )
          }
          leave={() => undefined}
          key="other"
        />,
      ),
    );
    expect(signInRenders.count).toBeGreaterThan(0);
    await act(async () => root.unmount());
  });
});
