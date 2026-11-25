import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/components/Session';
import { ApiError } from '../src/lib/api';
import { errorMessage } from '../src/lib/errors';
import { fakeApi, fakeReader, sessionDeps, storeView } from './fakes';
import { type Mounted, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(delegation: { linked: boolean; active: boolean } | undefined) {
  const api = fakeApi({
    store: vi.fn(async () => storeView(delegation === undefined ? {} : { delegation })),
  });
  mounted = await mount(
    <Session
      deps={sessionDeps(api, fakeReader([]))}
      onSignOut={() => undefined}
      onReplaceKey={() => undefined}
    />,
  );
  const container = mounted.container;
  await settle(() => !(container.textContent ?? '').includes('Loading your store'));
  return container.textContent ?? '';
}

describe('the standalone admin for a store the Shopify app manages (askr-shopify 5.3)', () => {
  it('shows only that the app manages it, with no tab to change anything', async () => {
    const text = await open({ linked: true, active: true });
    expect(text).toContain('Managed by the Shopify app');
    expect(text).not.toContain('Settings');
  });

  it('opens as before without a delegate, and against a server that names none', async () => {
    for (const delegation of [{ linked: true, active: false }, undefined]) {
      const text = await open(delegation);
      expect(text).not.toContain('Managed by the Shopify app');
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('explains the server refusal to an admin that wrote anyway', () => {
    expect(errorMessage(new ApiError(409, 'managed_by_delegate'))).toContain('Askr app in Shopify');
  });
});
