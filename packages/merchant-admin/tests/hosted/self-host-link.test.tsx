import { afterEach, describe, expect, it } from 'vitest';
import { SignIn } from '../../src/components/SignIn';
import { type Mounted, mount } from '../mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the self-host sign-in', () => {
  it('links to hosted mode, in this tab', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const hosted = [...mounted.container.querySelectorAll('main a')].find(
      (link) => link.getAttribute('href') === '/hosted/',
    );
    expect(hosted?.textContent).toBe('Sign in with your owner key');
    expect(hosted?.getAttribute('target')).toBeNull();
  });
});
