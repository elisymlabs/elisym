import type { Policy } from '@elisym/askr';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyRow } from '../src/components/PolicyRow';
import { type Mounted, click, mount } from './mount';

const POLICY: Policy = {
  author: 'a'.repeat(64),
  createdAt: 1_700_000_000,
  slug: 'returns',
  title: 'Returns',
  body: 'Return any unused item within 30 days.\nWe refund the full price.',
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function row(editable = true) {
  mounted = await mount(
    <ul>
      <PolicyRow
        policy={POLICY}
        editable={editable}
        imported={false}
        unread={false}
        busy={false}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />
    </ul>,
  );
  const toggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-controls]');
  const body = mounted.container.querySelector<HTMLElement>('#policy-body-returns');
  if (toggle === null || body === null) {
    throw new Error('no policy row');
  }
  return { toggle, body };
}

describe('a policy in the list', () => {
  it('shows its text folded to two lines, and in full once opened', async () => {
    const { toggle, body } = await row();
    expect(body.textContent).toBe(POLICY.body);
    expect(toggle.getAttribute('aria-controls')).toBe('policy-body-returns');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.classList.contains('line-clamp-2')).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.classList.contains('line-clamp-2')).toBe(false);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.classList.contains('line-clamp-2')).toBe(true);
  });

  it('opens one it cannot edit too, such as an imported one', async () => {
    const { toggle, body } = await row(false);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.textContent).toBe(POLICY.body);
  });
});
