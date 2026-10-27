import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARBITRUM_GLYPH,
  BASE_GLYPH,
  ETHEREUM_GLYPH,
  SOLANA_GLYPH,
  TEMPO_GLYPH,
} from '../../checkout/src/app/ui/glyphs';
import { AGENT_RUN } from '../src/components/AgentTab';
import { ChainMark, type MockChain } from '../src/components/ChainMark';
import { CheckoutMock, MOCK_PAYOUTS } from '../src/components/CheckoutMock';
import { Demo } from '../src/components/Demo';
import { copyText } from '../src/components/Snippet';
import { AGENT_PROMPT } from '../src/constants';
import { htmlSnippet, reactSnippet } from '../src/snippets';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGES = join(process.cwd(), '..');

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function combobox(page: HTMLElement): HTMLButtonElement {
  const found = page.querySelector('[role="combobox"]');
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error('no combobox');
  }
  return found;
}

async function key(target: HTMLElement, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

function shownPayout(page: HTMLElement): string {
  return combobox(page).textContent ?? '';
}

const CHAINS: readonly MockChain[] = ['solana', 'tempo', 'ethereum', 'arbitrum', 'base'];

const CHECKOUT_GLYPHS: Record<MockChain, string> = {
  solana: SOLANA_GLYPH,
  tempo: TEMPO_GLYPH,
  ethereum: ETHEREUM_GLYPH,
  arbitrum: ARBITRUM_GLYPH,
  base: BASE_GLYPH,
};

/** A gradient's id draws nothing and differs (`useId` vs `sol-g`). */
const UNDRAWN_ATTRIBUTES = new Set(['id']);

/** The outer `<svg>` is sized and labeled by its page (`class`, `aria-hidden`) or file (`xmlns`). */
const UNDRAWN_ROOT_ATTRIBUTES = new Set(['id', 'xmlns', 'class', 'aria-hidden']);

/**
 * Every shape of a mark with every attribute it draws, sorted: a polygon as the
 * path it outlines, and a `url(#id)` fill as the kind of element it resolves to
 * inside the mark, so a broken reference shows.
 */
function shapesOf(mark: Element): string[] {
  return [mark, ...mark.querySelectorAll('*')].map((shape) => {
    const undrawn = shape === mark ? UNDRAWN_ROOT_ATTRIBUTES : UNDRAWN_ATTRIBUTES;
    const drawn = [...shape.attributes]
      .filter((attribute) => !undrawn.has(attribute.name))
      .map((attribute) => {
        if (attribute.name === 'points') {
          return `d=M${attribute.value.split(' ').join(' L')} Z`;
        }
        const reference = /^url\(#(.+)\)$/.exec(attribute.value)?.[1];
        if (reference === undefined) {
          return `${attribute.name}=${attribute.value}`;
        }
        const target = mark.querySelector(`[id="${reference}"]`);
        return `${attribute.name}=url->${target === null ? 'missing' : target.tagName}`;
      })
      .sort();
    return [shape.tagName === 'polygon' ? 'path' : shape.tagName, ...drawn].join(' ');
  });
}

function checkoutGlyph(chain: MockChain): Element {
  const markup = decodeURIComponent(CHECKOUT_GLYPHS[chain].replace('data:image/svg+xml,', ''));
  return new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
}

describe('the chain marks', () => {
  it('draw each chain as the checkout does', async () => {
    const page = await render(
      <>
        {CHAINS.map((chain) => (
          <ChainMark key={chain} chain={chain} />
        ))}
      </>,
    );
    const marks = page.querySelectorAll(':scope > svg');
    expect(marks).toHaveLength(CHAINS.length);
    CHAINS.forEach((chain, index) => {
      const drawn = marks[index];
      if (drawn === undefined) {
        throw new Error(`no mark for ${chain}`);
      }
      expect(shapesOf(drawn), chain).toEqual(shapesOf(checkoutGlyph(chain)));
    });
  });

  it('name each chain as the checkout does', () => {
    const text = readFileSync(join(PACKAGES, 'checkout/src/app/ui/text.ts'), 'utf8');
    const start = text.indexOf('export const CHAIN_NAMES');
    expect(start).toBeGreaterThan(-1);
    const names = text.slice(start, text.indexOf('};', start));
    for (const payout of MOCK_PAYOUTS) {
      expect(names).toContain(`  ${payout.chain}: '${payout.chainLabel}',`);
    }
  });
});

describe('the checkout drawing', () => {
  it('opens the Pay with list on click and picks a payout', async () => {
    const page = await render(<CheckoutMock />);
    expect(page.querySelector('[role="listbox"]')).toBeNull();
    expect(shownPayout(page)).toBe('USDC · Solana');
    await act(async () => combobox(page).click());
    const options = [...page.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      'USDC · Solana',
      'USDC.e · Tempo',
      'pathUSD · Tempo',
      'USDC · Ethereum',
      'USDC · Arbitrum',
      'USDC · Base',
    ]);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    await act(async () => (options[2] as HTMLElement).click());
    expect(page.querySelector('[role="listbox"]')).toBeNull();
    expect(shownPayout(page)).toBe('pathUSD · Tempo');
    expect(page.textContent).toContain('Any installed wallet for Tempo');
  });

  it('works from the keyboard: arrows move, Enter picks, Escape closes', async () => {
    const page = await render(<CheckoutMock />);
    const box = combobox(page);
    await key(box, 'ArrowDown');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    await key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(
      page.querySelectorAll('[role="option"]')[1]?.id,
    );
    await key(box, 'Enter');
    expect(shownPayout(page)).toBe('USDC.e · Tempo');
    expect(box.getAttribute('aria-expanded')).toBe('false');
    await key(box, 'ArrowDown');
    await key(box, 'ArrowUp');
    await key(box, 'Escape');
    expect(page.querySelector('[role="listbox"]')).toBeNull();
    expect(shownPayout(page)).toBe('USDC.e · Tempo');
  });

  it('closes on a press outside it, and when focus leaves it', async () => {
    const page = await render(<CheckoutMock />);
    await act(async () => combobox(page).click());
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(page.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => combobox(page).click());
    const inside = page.querySelector('[role="option"]');
    await act(async () => {
      inside?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(page.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      combobox(page).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(page.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps focus on the list while an option is pressed, so the press lands', async () => {
    const page = await render(<CheckoutMock />);
    await act(async () => combobox(page).click());
    const press = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    page.querySelector('[role="option"]')?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('reopens on the chosen option, wraps, jumps with Home and End, and picks with Space', async () => {
    const page = await render(<CheckoutMock />);
    const box = combobox(page);
    const activeIndex = () =>
      [...page.querySelectorAll('[role="option"]')].findIndex(
        (option) => option.id === box.getAttribute('aria-activedescendant'),
      );
    await key(box, 'ArrowDown');
    await key(box, 'ArrowDown');
    await key(box, 'ArrowDown');
    await key(box, ' ');
    expect(shownPayout(page)).toBe('pathUSD · Tempo');
    await key(box, 'ArrowDown');
    expect(activeIndex()).toBe(2);
    await key(box, 'ArrowDown');
    expect(activeIndex()).toBe(3);
    await key(box, 'End');
    expect(activeIndex()).toBe(5);
    await key(box, 'ArrowDown');
    expect(activeIndex()).toBe(0);
    await key(box, 'ArrowUp');
    expect(activeIndex()).toBe(5);
    await key(box, 'Home');
    expect(activeIndex()).toBe(0);
  });

  it('offers only coins the payment registry knows', () => {
    const assets = readFileSync(join(PACKAGES, 'pay-core/src/payment/assets.ts'), 'utf8');
    for (const payout of MOCK_PAYOUTS) {
      expect(assets).toContain(`symbol: '${payout.coin}'`);
    }
  });
});

describe('the integration card', () => {
  it('copies the code on the code tabs and the prompt on the agent tab', () => {
    expect(copyText('HTML', undefined)).toBe(htmlSnippet());
    expect(copyText('React', 'naddr1x')).toBe(reactSnippet('naddr1x'));
    expect(copyText('AI agent', undefined)).toBe(AGENT_PROMPT);
  });

  it('the Copy prompt button puts the prompt on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const page = await render(<Demo demo={undefined} />);
    const agentTab = [...page.querySelectorAll('button')].find(
      (button) => button.textContent === 'AI agent',
    );
    await act(async () => agentTab?.click());
    const copy = [...page.querySelectorAll('button')].find(
      (button) => button.textContent === 'Copy prompt',
    );
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(AGENT_PROMPT);
  });

  it('the side card opens the agent tab', async () => {
    const page = await render(<Demo demo={undefined} />);
    const card = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Or let your AI agent do it'),
    );
    await act(async () => card?.click());
    expect(page.querySelector('#agent-prompt')?.textContent).toBe(AGENT_PROMPT);
  });

  it('moves between tabs with the arrow keys', async () => {
    const page = await render(<Demo demo={undefined} />);
    const html = page.querySelector('#snippet-tab-html');
    if (!(html instanceof HTMLElement)) {
      throw new Error('no HTML tab');
    }
    await key(html, 'ArrowLeft');
    const agent = page.querySelector('#snippet-tab-agent');
    expect(agent?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(agent);
    if (agent instanceof HTMLElement) {
      await key(agent, 'ArrowRight');
      expect(document.activeElement).toBe(page.querySelector('#snippet-tab-html'));
      await key(html, 'End');
      expect(document.activeElement).toBe(agent);
      await key(agent, 'Home');
      expect(document.activeElement).toBe(page.querySelector('#snippet-tab-html'));
    }
    expect(page.querySelector('#snippet-panel')?.getAttribute('aria-labelledby')).toBe(
      'snippet-tab-html',
    );
  });

  it('draws only commands the merchant CLI has', () => {
    const cli = readFileSync(join(PACKAGES, 'merchant-node/src/cli.ts'), 'utf8');
    const commands = AGENT_RUN.filter((line) => line.mark === '$');
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) {
      const [npx, pkg, subcommand] = line.text.split(' ');
      expect(`${npx} ${pkg}`).toBe('npx @elisym/merchant-node');
      expect(cli).toMatch(new RegExp(`\\n  ${subcommand} `));
    }
  });
});
