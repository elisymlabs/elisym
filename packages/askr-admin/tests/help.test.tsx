import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { InfoTip } from '../src/components/InfoTip';
import { ADMIN_DOCS_URL } from '../src/constants';
import { HELP, helpUrl } from '../src/lib/help';
import { type Mounted, click, mount } from './mount';

// Tests run from the package's own folder.
const GUIDE = readFileSync(join(process.cwd(), '../docs/pages/askr/admin.mdx'), 'utf8');
const EM_DASH = String.fromCharCode(0x2014);

/** A heading's link anchor, as the docs site makes it. */
function slugOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const ANCHORS = GUIDE.split('\n')
  .filter((line) => /^#{2,3} /.test(line))
  .map((line) => slugOf(line.replace(/^#+ /, '')));

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the help', () => {
  it('links every entry to a section of the admin guide, no two guide headings alike', () => {
    expect(new Set(ANCHORS).size).toBe(ANCHORS.length);
    const missing = Object.entries(HELP)
      .filter(([, help]) => !ANCHORS.includes(help.anchor))
      .map(([key]) => key);
    expect(missing).toEqual([]);
    expect(helpUrl(HELP.storeName)).toBe(`${ADMIN_DOCS_URL}#store-name`);
  });

  it('says something short in every entry, with no em dash', () => {
    for (const [key, help] of Object.entries(HELP)) {
      expect(help.text.length, key).toBeGreaterThan(20);
      expect(help.text.length, key).toBeLessThan(400);
      expect(help.text, key).not.toContain(EM_DASH);
    }
    expect(GUIDE).not.toContain(EM_DASH);
  });
});

describe('the info button', () => {
  async function tip() {
    mounted = await mount(
      <div>
        <InfoTip help={HELP.storeName} about="Store name" />
        <p id="elsewhere">elsewhere</p>
      </div>,
    );
    const button = mounted.container.querySelector<HTMLButtonElement>('button');
    if (button === null) {
      throw new Error('no info button');
    }
    return { container: mounted.container, button };
  }

  it('opens on a press with the text and a link to the guide, and closes on another', async () => {
    const { container, button } = await tip();
    expect(button.getAttribute('aria-label')).toBe('About Store name');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="note"]')).toBeNull();
    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const note = container.querySelector('[role="note"]');
    expect(note?.id).toBe(button.getAttribute('aria-controls'));
    expect(note?.textContent).toContain(HELP.storeName.text);
    const link = note?.querySelector('a');
    expect(link?.href).toBe(`${ADMIN_DOCS_URL}#store-name`);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noreferrer');
    await click(button);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('closes on Escape, giving focus back to the button', async () => {
    const { container, button } = await tip();
    await click(button);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press elsewhere, but not on a press inside it', async () => {
    const { container, button } = await tip();
    await click(button);
    const note = container.querySelector('[role="note"]');
    await act(async () => {
      note?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="note"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector('#elsewhere')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('sits outside the label, so the label names only its field', async () => {
    const { TextField } = await import('../src/components/TextField');
    mounted = await mount(
      <TextField
        id="probe"
        label="Probe"
        value=""
        info={HELP.storeName}
        onChange={() => undefined}
      />,
    );
    const label = mounted.container.querySelector('label[for="probe"]');
    expect(label?.textContent).toBe('Probe');
    expect(label?.querySelector('button')).toBeNull();
    expect(mounted.container.querySelector('button[aria-label="About Probe"]')).not.toBeNull();
  });
});
