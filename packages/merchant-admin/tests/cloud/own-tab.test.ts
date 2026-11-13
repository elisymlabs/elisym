import { describe, expect, it } from 'vitest';
import { type TabView, claimWindow, isOwnTab } from '../../src/cloud/lib/own-tab';

/** A stand-in window: opened by another page or not, framed or not, with a name left on it. */
function view(options: { opened?: boolean; framed?: boolean }): TabView {
  const fake: TabView = {
    opener: options.opened === true ? {} : null,
    top: null,
    name: 'left by another page',
  };
  fake.top = options.framed === true ? {} : fake;
  return fake;
}

describe("the console's own tab", () => {
  it('is its own tab only when no page opened it and none frames it', () => {
    expect(isOwnTab(view({}))).toBe(true);
    expect(isOwnTab(view({ opened: true }))).toBe(false);
    expect(isOwnTab(view({ framed: true }))).toBe(false);
    expect(isOwnTab(view({ opened: true, framed: true }))).toBe(false);
  });

  it('claiming the window clears its name, whatever the answer', () => {
    for (const options of [{}, { opened: true }, { framed: true }]) {
      const tab = view(options);
      expect(claimWindow(tab)).toBe(isOwnTab(view(options)));
      expect(tab.name).toBe('');
    }
  });
});
