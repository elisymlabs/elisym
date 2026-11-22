import { LIMITS } from '@elisym/askr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreFields } from '../src/components/StoreFields';
import { HELP } from '../src/lib/help';
import { EMPTY_FORM } from '../src/lib/store-form';
import { type Mounted, byId, mount } from './mount';

// A limit other than the real one: the texts follow LIMITS, not a number written into them.
vi.mock('@elisym/askr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@elisym/askr')>();
  return { ...actual, LIMITS: { ...actual.LIMITS, LAUNCHER_TEXT_CHARS: 31 } };
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the chat button text limit in the admin', () => {
  it('the field hint and the help text name the limit from LIMITS', async () => {
    expect(LIMITS.LAUNCHER_TEXT_CHARS).toBe(31);
    mounted = await mount(<StoreFields form={EMPTY_FORM} onChange={() => undefined} />);
    const field = byId(mounted.container, 'store-launcher-text');
    const hintId = field.getAttribute('aria-describedby');
    expect(hintId).toBe('store-launcher-text-hint');
    expect(mounted.container.querySelector(`#${hintId}`)?.textContent).toBe(
      `Up to ${LIMITS.LAUNCHER_TEXT_CHARS} characters. Empty shows "Ask AI" in the visitor's language.`,
    );
    expect(HELP.launcherText.text).toContain(`up to ${LIMITS.LAUNCHER_TEXT_CHARS} characters`);
  });
});
