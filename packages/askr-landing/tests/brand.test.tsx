import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { markPaths as widgetMarkPaths } from '../../askr-widget/src/ui/mark';
import { formatAmount } from '../../askr-widget/src/ui/price';
import { STRINGS } from '../../askr-widget/src/ui/strings';
import { ADMIN_ICON_PATHS, ADMIN_TABS, OVERVIEW_DESCRIPTION } from '../src/admin-view';
import { App } from '../src/App';
import { MARK_STILL_PATHS, WORDMARK_PATH } from '../src/brand';
import { DRIFT_START, driftViewpoint, markPaths } from '../src/mark';
import { PRODUCTS } from '../src/media';
import { WIDGET_TEXT } from '../src/widget-text';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGES = join(process.cwd(), '..');

function read(path: string): string {
  return readFileSync(join(PACKAGES, path), 'utf8');
}

describe('the brand', () => {
  it('draws the mark and the wordmark the admin and the widget draw', () => {
    const adminMark = read('askr-admin/src/components/AskrMark.tsx');
    for (const path of MARK_STILL_PATHS) {
      expect(adminMark).toContain(`'${path}'`);
    }
    expect(MARK_STILL_PATHS).toHaveLength(7);
    expect(read('askr-admin/src/components/AskrLogo.tsx')).toContain(WORDMARK_PATH);
    expect(read('askr-widget/src/ui/wordmark.ts')).toContain(WORDMARK_PATH);
  });

  it('moves the mark the way the widget does', () => {
    for (const time of [DRIFT_START, 3, 7.5, 40]) {
      expect(markPaths(driftViewpoint(time))).toEqual(widgetMarkPaths(time));
    }
  });

  it('uses the admin favicon', () => {
    expect(read('askr-landing/public/favicon.svg')).toBe(read('askr-admin/public/favicon.svg'));
  });
});

describe('the drawing of the admin', () => {
  it('uses its section ids, labels, icons and the Overview description', () => {
    const tabs = read('askr-admin/src/lib/tabs.ts');
    const ids = [...tabs.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
    expect(ADMIN_TABS.map((tab) => tab.id)).toEqual(ids);
    expect(tabs).toContain(OVERVIEW_DESCRIPTION);
    const icons = read('askr-admin/src/components/NavIcon.tsx');
    for (const paths of Object.values(ADMIN_ICON_PATHS)) {
      for (const path of paths) {
        expect(icons).toContain(`'${path}'`);
      }
    }
    expect(Object.keys(ADMIN_ICON_PATHS)).toEqual(ids);
  });
});

describe('the drawings of the widget', () => {
  it('use the widget texts', () => {
    for (const [key, text] of Object.entries(WIDGET_TEXT)) {
      expect(STRINGS[key as keyof typeof STRINGS], key).toBe(text);
    }
  });

  it('write each price as the widget cards do', () => {
    for (const product of Object.values(PRODUCTS)) {
      const amount = product.price.replace(/ USD$/, '');
      expect(formatAmount(amount, 'USD')).toBe(product.price);
    }
  });

  it('list the admin sections the admin has, in its order', async () => {
    const labels = [...read('askr-admin/src/lib/tabs.ts').matchAll(/label: '([^']+)'/g)].map(
      (match) => match[1],
    );
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<App />));
    const drawn = [...container.querySelectorAll('#admin figure li')].map(
      (item) => item.textContent?.trim() ?? '',
    );
    expect(drawn).toEqual(labels);
    await act(async () => root.unmount());
  });
});
