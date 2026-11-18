import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfoTip, panelShift } from '../src/components/InfoTip';
import { ADMIN_DOCS_URL } from '../src/constants';
import { HELP, helpUrl } from '../src/lib/help';
import { type Mounted, click, mount } from './mount';

// Tests run from the package's own folder.
const GUIDE = readFileSync(join(process.cwd(), '../docs/pages/askr/admin.mdx'), 'utf8');
const EM_DASH = String.fromCharCode(0x2014);

/** A heading's link anchor, as the docs site makes it. */
function slugOf(heading: string): string {
  // As github-slugger (the docs site's): keep letters, marks, digits, connectors, hyphens
  // and spaces, then spaces become hyphens.
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
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

  it('closes on Escape, giving focus back to the button from inside the tip', async () => {
    const { container, button } = await tip();
    await click(button);
    const link = container.querySelector<HTMLAnchorElement>('[role="note"] a');
    link?.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on Escape without taking focus from a field the visitor moved to', async () => {
    mounted = await mount(
      <div>
        <InfoTip help={HELP.storeName} about="Store name" />
        <input id="elsewhere-field" />
      </div>,
    );
    const { container } = mounted;
    const button = container.querySelector<HTMLButtonElement>('button');
    const field = container.querySelector<HTMLInputElement>('#elsewhere-field');
    if (button === null || field === null) {
      throw new Error('not rendered');
    }
    await click(button);
    field.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('moves the panel just enough to stay between the edges, at any width', () => {
    // Wide: room to the right, no shift.
    expect(panelShift(300, 1280, 1280)).toBe(0);
    // Near the right edge: moved left to end 16px before it.
    expect(panelShift(1100, 1280, 1280)).toBe(1280 - 16 - 280 - 1100);
    // The edge of main, narrower than the window, counts.
    expect(panelShift(700, 900, 1280)).toBe(900 - 16 - 280 - 700);
    // A phone: the panel narrows to the window less 48px and never starts past the left edge.
    for (const left of [20, 79, 120, 200, 266, 340]) {
      const shift = panelShift(left, 375, 375);
      const width = Math.min(280, 375 - 48);
      expect(left + shift, `left ${left}`).toBeGreaterThanOrEqual(16);
      expect(left + shift + width, `left ${left}`).toBeLessThanOrEqual(375 - 16 + 1);
    }
  });

  it('sets the shift on the panel when it opens', async () => {
    const { container, button } = await tip();
    const box = button.parentElement;
    if (box === null) {
      throw new Error('no box');
    }
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(window.innerWidth - 100, 0, 14, 14),
    );
    await click(button);
    const note = container.querySelector<HTMLElement>('[role="note"]');
    expect(note?.style.left).toBe(
      `${panelShift(window.innerWidth - 100, window.innerWidth, window.innerWidth)}px`,
    );
    expect(Number.parseFloat(note?.style.left ?? '0')).toBeLessThan(0);
  });

  it('leaves every kind of field named by its own label', async () => {
    const { TextAreaField } = await import('../src/components/TextAreaField');
    const { SelectField } = await import('../src/components/SelectField');
    mounted = await mount(
      <div>
        <TextAreaField
          id="area"
          label="Area"
          value=""
          info={HELP.notes}
          onChange={() => undefined}
        />
        <SelectField
          id="choice"
          label="Choice"
          value="a"
          options={[{ value: 'a', label: 'A' }]}
          info={HELP.platform}
          onChange={() => undefined}
        />
      </div>,
    );
    for (const [id, name] of [
      ['area', 'Area'],
      ['choice', 'Choice'],
    ]) {
      const label = mounted.container.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      expect(label?.textContent, id).toBe(name);
      expect(mounted.container.querySelector(`#${id}`), id).not.toBeNull();
      expect(
        mounted.container.querySelector(`button[aria-label="About ${name}"]`),
        id,
      ).not.toBeNull();
    }
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
