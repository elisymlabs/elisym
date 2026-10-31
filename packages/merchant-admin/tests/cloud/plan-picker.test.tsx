import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanPicker } from '../../src/cloud/components/PlanPicker';
import type { TierCard } from '../../src/cloud/lib/tiers';
import { type Mounted, mount, settle } from '../mount';

function tier(id: string, payable: boolean) {
  return {
    id,
    name: id,
    price: '$1/mo',
    selfServe: true,
    limits: { products: 10 },
    display: {},
    ownRpc: false,
    payable: { card: false, crypto: payable },
  };
}

/** Three plans that can start, and one that cannot between the first two. */
const CATALOG = {
  tiers: [tier('one', true), tier('closed', false), tier('two', true), tier('three', true)],
};

function Picker() {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  return (
    <PlanPicker
      loadTiers={async () => ({ status: 200, body: CATALOG })}
      preselect={undefined}
      chosen={chosen}
      onChoose={(picked: TierCard) => setChosen(picked.id)}
      locked={false}
    />
  );
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function card(container: HTMLElement, id: string): HTMLButtonElement {
  const found = container.querySelector(`[data-tier="${id}"]`);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`no card ${id}`);
  }
  return found;
}

/** Presses `key` on the card `id`; whether the page's own handling was prevented. */
async function press(container: HTMLElement, id: string, key: string): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    card(container, id).dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const checked = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) =>
    node.getAttribute('data-tier'),
  );
const tabStops = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="radio"]')]
    .filter((node) => node instanceof HTMLButtonElement && node.tabIndex === 0)
    .map((node) => node.getAttribute('data-tier'));

describe('the plans as a radio group', () => {
  it('arrows walk the plans that can start, in order, skipping one that cannot', async () => {
    mounted = await mount(<Picker />);
    const { container } = mounted;
    await settle(() => container.querySelector('[data-tier="one"]') !== null);
    expect(card(container, 'closed').disabled).toBe(true);
    expect(tabStops(container)).toEqual(['one']);

    // Right from the first: past the closed plan, to the second that can start.
    expect(await press(container, 'one', 'ArrowRight')).toBe(true);
    expect(checked(container)).toEqual(['two']);
    expect(document.activeElement).toBe(card(container, 'two'));
    // The one tab stop follows the plan picked.
    expect(tabStops(container)).toEqual(['two']);

    expect(await press(container, 'two', 'ArrowRight')).toBe(true);
    expect(checked(container)).toEqual(['three']);
    expect(tabStops(container)).toEqual(['three']);

    // Left goes back the same way, and wraps from the first to the last.
    expect(await press(container, 'three', 'ArrowLeft')).toBe(true);
    expect(checked(container)).toEqual(['two']);
    expect(await press(container, 'two', 'ArrowLeft')).toBe(true);
    expect(checked(container)).toEqual(['one']);
    expect(await press(container, 'one', 'ArrowLeft')).toBe(true);
    expect(checked(container)).toEqual(['three']);
    expect(document.activeElement).toBe(card(container, 'three'));

    // Any other key is the page's own.
    expect(await press(container, 'three', 'a')).toBe(false);
    expect(checked(container)).toEqual(['three']);
  });
});
