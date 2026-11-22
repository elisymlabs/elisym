// @vitest-environment happy-dom
import {
  type CatalogItem,
  buildCatalogItemEvent,
  buildConfigEvent,
  parseCatalogItem,
  parseConfig,
} from '@elisym/askr';
import type { Answer, Component } from '@elisym/askr/chat';
import { afterEach, describe, expect, it } from 'vitest';
import { type AnswerContext, renderAnswer } from '../src/ui/answer-view';
import { STRINGS } from '../src/ui/strings';
import { WIDGET_CSS } from '../src/ui/styles';
import { localSecs, makeStore, sign, testKey } from './fixtures';

const PRODUCT_NAMES = ['Trail runner', 'Road racer', 'Daily trainer', 'Stability pro'] as const;

function catalogItem(slug: string, title: string): CatalogItem {
  const key = testKey();
  const item = parseCatalogItem(
    sign(
      buildCatalogItemEvent({
        d: slug,
        title,
        price: { amount: '99', currency: 'USD' },
        url: `https://shop.example/p/${slug}`,
        createdAt: localSecs() - 10,
      }),
      key,
    ),
  );
  if (!item) {
    throw new Error('item did not parse');
  }
  return item;
}

function answerContext(items: Map<string, CatalogItem>): AnswerContext {
  const store = makeStore();
  const config = parseConfig(
    sign(buildConfigEvent(store.configInput, store.owner.secretKey), store.owner),
  );
  if (!config) {
    throw new Error('config did not parse');
  }
  return {
    document,
    config,
    reportClick: () => undefined,
    pageOrigin: 'https://shop.example',
    resolveCards: async () => items,
  };
}

function answerWith(component: Component): Answer {
  return {
    type: 'answer',
    ask_id: 'a'.repeat(32),
    session_end: localSecs() + 86_400,
    text: '',
    components: [component],
    chips: [],
  };
}

/** A comparison of the first `count` products, rendered and settled. */
async function renderComparison(count: number, title?: string): Promise<HTMLElement> {
  const items = new Map<string, CatalogItem>();
  const addresses = PRODUCT_NAMES.slice(0, count).map((name, index) => {
    const address = `30402:${'b'.repeat(64)}:shoe-${index}`;
    items.set(address, catalogItem(`shoe-${index}`, name));
    return address;
  });
  const component: Component = {
    type: 'comparison',
    ...(title === undefined ? {} : { title }),
    addresses,
    rows: [
      { dimension: 'Weight', cells: addresses.map((_address, index) => `${250 + index * 10} g`) },
      { dimension: 'Drop', cells: addresses.map(() => '8 mm') },
    ],
    recommended: addresses[0],
  };
  const answer = renderAnswer(answerContext(items), answerWith(component));
  document.body.append(answer);
  await Promise.resolve();
  await Promise.resolve();
  return answer;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('comparison tables', () => {
  it('puts a four-product table in a focusable region that scrolls sideways', async () => {
    const answer = await renderComparison(4, 'Running shoes');
    const scroll = answer.querySelector<HTMLElement>('.table-scroll');
    if (!scroll) {
      throw new Error('no scroll box');
    }
    expect(scroll.tabIndex).toBe(0);
    expect(scroll.getAttribute('role')).toBe('region');
    expect(scroll.getAttribute('aria-label')).toBe('Running shoes');
    const table = scroll.querySelector('table');
    expect(table?.parentElement).toBe(scroll);
    expect(answer.querySelectorAll('table')).toHaveLength(1);
    const header = Array.from(table?.querySelectorAll('tr:first-child > th') ?? []);
    expect(header).toHaveLength(5);
    expect(header.slice(1).map((cell) => cell.firstChild?.textContent)).toEqual([...PRODUCT_NAMES]);
    expect(header[1]?.querySelector('.label.recommended')?.textContent).toBe(STRINGS.recommended);
    expect(table?.querySelectorAll('td')).toHaveLength(8);
  });

  it('names an untitled comparison region in the widget language', async () => {
    const answer = await renderComparison(4);
    expect(answer.querySelector('.table-scroll')?.getAttribute('aria-label')).toBe(
      STRINGS.comparison,
    );
  });

  it('renders a two-product table the same way', async () => {
    const answer = await renderComparison(2);
    const table = answer.querySelector('.table-scroll > table');
    expect(table?.querySelectorAll('tr')).toHaveLength(3);
    expect(table?.querySelectorAll('tr:first-child > th')).toHaveLength(3);
    expect(Array.from(table?.querySelectorAll('td') ?? []).map((cell) => cell.textContent)).toEqual(
      ['250 g', '260 g', '8 mm', '8 mm'],
    );
  });

  it('keeps model text in cells as text: no markup from a cell becomes an element', async () => {
    const items = new Map([[`30402:${'b'.repeat(64)}:x`, catalogItem('x', 'X')]]);
    const [address] = items.keys();
    if (address === undefined) {
      throw new Error('no address');
    }
    const other = `30402:${'b'.repeat(64)}:y`;
    items.set(other, catalogItem('y', 'Y'));
    const answer = renderAnswer(
      answerContext(items),
      answerWith({
        type: 'comparison',
        title: '<img src=x onerror=alert(1)>',
        addresses: [address, other],
        rows: [{ dimension: '<b>Size</b>', cells: ['<script>1</script>', 'ok'] }],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(answer.querySelector('img, script, b')).toBeNull();
    expect(answer.querySelector('td')?.textContent).toBe('<script>1</script>');
    expect(answer.querySelector('.table-scroll')?.getAttribute('aria-label')).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('drags sideways under a mouse, as a row of cards does', async () => {
    const answer = await renderComparison(4, 'Running shoes');
    const scroll = answer.querySelector<HTMLElement>('.table-scroll');
    if (!scroll) {
      throw new Error('no scroll box');
    }
    scroll.setPointerCapture = () => undefined;
    scroll.releasePointerCapture = () => undefined;
    scroll.hasPointerCapture = () => false;
    const press = (type: string, clientX: number): void => {
      scroll.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX,
        }),
      );
    };
    scroll.scrollLeft = 0;
    press('pointerdown', 200);
    press('pointermove', 150);
    expect(scroll.classList.contains('dragging')).toBe(true);
    press('pointermove', 90);
    expect(scroll.scrollLeft).toBe(60);
    press('pointerup', 90);
    expect(scroll.classList.contains('dragging')).toBe(false);
  });

  it('shows a grab hand on a comparison wider than the panel, a closed hand while dragging', () => {
    expect(WIDGET_CSS).toContain('.table-scroll:has(tr > :nth-child(4)) { cursor: grab; }');
    expect(WIDGET_CSS).toContain(
      '.table-scroll.dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }',
    );
  });

  it('styles the box to scroll sideways with rounded, clipped corners and readable columns', () => {
    const rule = /\.table-scroll \{([^}]*)\}/u.exec(WIDGET_CSS)?.[1] ?? '';
    expect(rule).toContain('overflow-x: auto;');
    expect(rule).toContain('max-width: 100%;');
    expect(rule).toContain('border-radius: min(12px, var(--cc-radius));');
    expect(WIDGET_CSS).toContain(
      '.table-scroll table { border-collapse: separate; border-spacing: 0;',
    );
    const cells = /\.table-scroll th, \.table-scroll td \{([^}]*)\}/u.exec(WIDGET_CSS)?.[1] ?? '';
    expect(cells).toContain('min-width: 96px;');
    expect(cells).toContain('overflow-wrap: break-word;');
    expect(WIDGET_CSS).toMatch(/\.table-scroll tr > th:first-child \{\s*position: sticky;/u);
    expect(WIDGET_CSS).toContain(
      '.table-scroll tr:first-child > th { background: var(--cc-surface);',
    );
    expect(WIDGET_CSS).toContain('.component > .table-scroll,');
  });
});
