import type { Policy } from '@elisym/askr';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyRow } from '../src/components/PolicyRow';
import { type Mounted, mount } from './mount';

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
  return mounted.container;
}

describe('a policy in the list', () => {
  it('shows its whole text, line breaks kept, with nothing to unfold', async () => {
    const container = await row();
    const body = container.querySelector('p');
    expect(body?.textContent).toBe(POLICY.body);
    expect(body?.classList.contains('whitespace-pre-line')).toBe(true);
    expect(body?.className).not.toContain('line-clamp');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('shows the text of one it cannot edit too, such as an imported one', async () => {
    const container = await row(false);
    expect(container.querySelector('p')?.textContent).toBe(POLICY.body);
    expect(container.querySelector('button')).toBeNull();
  });
});
