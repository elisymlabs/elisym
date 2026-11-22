// @vitest-environment happy-dom
import { buildConfigEvent, parseConfig } from '@elisym/askr';
import { afterEach, describe, expect, it } from 'vitest';
import { snippetAttributes } from '../src/snippet';
import { WidgetView } from '../src/ui/element';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  STRINGS,
  applyLanguage,
  resolveLanguage,
  supportedLanguage,
} from '../src/ui/strings';
import { makeStore, sign, testKey } from './fixtures';

function storeIn(language: string) {
  const key = testKey();
  const config = parseConfig(
    sign(buildConfigEvent({ ...makeStore().configInput, language }, key.secretKey), key),
  );
  if (!config) {
    throw new Error('no config');
  }
  return config;
}

function view(hints: ReadonlyArray<string | null>): WidgetView {
  return new WidgetView(
    document,
    () => undefined,
    () => undefined,
    () => hints,
  );
}

function launcherText(widget: WidgetView): string | null | undefined {
  return widget.launcher.querySelector('.launcher-label')?.textContent;
}

afterEach(() => {
  applyLanguage(DEFAULT_LANGUAGE);
});

describe('the widget language', () => {
  it('reads the primary subtag, any case or separator, and only languages it speaks', () => {
    expect(supportedLanguage('pt-BR')).toBe('pt');
    expect(supportedLanguage('ZH_Hant')).toBe('zh');
    expect(supportedLanguage(' ja ')).toBe('ja');
    expect(supportedLanguage('pl')).toBeUndefined();
    expect(supportedLanguage('')).toBeUndefined();
    expect(supportedLanguage(null)).toBeUndefined();
    expect(supportedLanguage('constructor')).toBeUndefined();
  });

  it('takes the first hint it speaks, else English', () => {
    expect(resolveLanguage(['pl', 'de', 'fr'])).toBe('de');
    expect(resolveLanguage([null, undefined, 'ko'])).toBe('ko');
    expect(resolveLanguage(['pl'])).toBe('en');
    expect(resolveLanguage([])).toBe('en');
  });

  it('has every text in every language, none blank and no em dash', () => {
    const keys = Object.keys(LANGUAGES.en ?? {}).sort();
    expect(Object.keys(LANGUAGES).sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh'].sort(),
    );
    for (const [code, texts] of Object.entries(LANGUAGES)) {
      expect(Object.keys(texts).sort(), code).toEqual(keys);
      for (const text of Object.values(texts)) {
        expect(text.trim(), code).not.toBe('');
        expect(text, code).not.toContain('—');
      }
    }
  });

  it("the snippet's data-lang wins over the page and the store", () => {
    const widget = view(['ru', 'de']);
    expect(launcherText(widget)).toBe('Спросить ИИ');
    // Its own texts carry its language; the answers keep the page's.
    expect(widget.panel.querySelector<HTMLElement>('.header')?.lang).toBe('ru');
    // The launcher's own words carry it, the button does not: a store's text keeps the page's.
    expect(widget.launcher.querySelector<HTMLElement>('.launcher-hint')?.lang).toBe('ru');
    expect(widget.launcher.querySelector<HTMLElement>('.launcher-label')?.lang).toBe('ru');
    expect(widget.launcher.hasAttribute('lang')).toBe(false);
    expect(widget.panel.lang).toBe('');
    expect(widget.launcher.querySelector('.launcher-hint')?.textContent).toBe(
      'О любом товаре здесь',
    );
    widget.update({ phase: 'ready', branding: true, turns: [], config: storeIn('fr') });
    expect(launcherText(widget)).toBe('Спросить ИИ');
    expect(widget.panel.querySelector('input')?.placeholder).toBe('Спросите о товарах...');
  });

  it("the page's lang comes next, then the store's language, then English", () => {
    const paged = view([null, 'de-AT']);
    expect(launcherText(paged)).toBe('KI fragen');
    const stored = view([null, 'pl']);
    expect(launcherText(stored)).toBe('Ask AI');
    stored.update({ phase: 'ready', branding: true, turns: [], config: storeIn('fr') });
    expect(launcherText(stored)).toBe("Demander à l'IA");
    expect(stored.launcher.querySelector('.launcher-hint')?.textContent).toBe(
      'Sur tous nos produits',
    );
    expect(stored.panel.querySelector('.close')?.getAttribute('aria-label')).toBe('Fermer');
    expect(stored.panel.querySelector('.powered span')?.textContent).toBe('Propulsé par');
    expect(STRINGS.addToCart).toBe('Ajouter au panier');
  });

  it("keeps the store's own greeting in any language", () => {
    const widget = view(['es']);
    const config = { ...storeIn('en'), greeting: 'Welcome to Northwind' };
    widget.update({ phase: 'ready', branding: true, turns: [], config });
    expect(widget.panel.querySelector('.bubble.theirs')?.textContent).toBe('Welcome to Northwind');
  });
});

describe("the store's launcher text", () => {
  function label(widget: WidgetView): HTMLElement {
    const found = widget.launcher.querySelector<HTMLElement>('.launcher-label');
    if (!found) {
      throw new Error('no label');
    }
    return found;
  }

  function hint(widget: WidgetView): HTMLElement {
    const found = widget.launcher.querySelector<HTMLElement>('.launcher-hint');
    if (!found) {
      throw new Error('no hint');
    }
    return found;
  }

  it.each([
    ['en', 'Ask AI', 'About any product here'],
    ['ru', 'Спросить ИИ', 'О любом товаре здесь'],
  ])('without one, %s shows the default label and the hint', (language, text, hintText) => {
    const widget = view([language]);
    expect(label(widget).textContent).toBe(text);
    expect(hint(widget).textContent).toBe(hintText);
    expect(hint(widget).hidden).toBe(false);
  });

  it('shows the text as written, hides the hint and leaves the widget language off it', () => {
    const widget = view(['ru']);
    widget.setLauncherText('Ask our stylist');
    expect(label(widget).textContent).toBe('Ask our stylist');
    expect(label(widget).getAttribute('dir')).toBe('auto');
    expect(label(widget).hasAttribute('lang')).toBe(false);
    expect(widget.launcher.hasAttribute('lang')).toBe(false);
    expect(hint(widget).hidden).toBe(true);
    expect(hint(widget).lang).toBe('ru');
  });

  it('keeps the text when a config changes the language', () => {
    const widget = view([null, 'pl']);
    widget.setLauncherText('Ask our stylist');
    const config = { ...storeIn('fr'), launcherText: 'Ask our stylist' };
    widget.update({ phase: 'ready', branding: true, turns: [], config });
    expect(hint(widget).textContent).toBe('Sur tous nos produits');
    expect(label(widget).textContent).toBe('Ask our stylist');
    expect(hint(widget).hidden).toBe(true);
  });

  it("takes a config's text over the check's, and restores the default without one", () => {
    const widget = view(['en']);
    widget.setLauncherText('From the check');
    const withText = { ...storeIn('en'), launcherText: 'From the config' };
    widget.update({ phase: 'ready', branding: true, turns: [], config: withText });
    expect(label(widget).textContent).toBe('From the config');
    widget.update({ phase: 'ready', branding: true, turns: [], config: storeIn('en') });
    expect(label(widget).textContent).toBe('Ask AI');
    expect(label(widget).hasAttribute('dir')).toBe(false);
    expect(label(widget).lang).toBe('en');
    expect(hint(widget).hidden).toBe(false);
  });

  it('renders markup as literal text', () => {
    const widget = view(['en']);
    widget.setLauncherText('<img src=x onerror=alert(1)>');
    expect(label(widget).textContent).toBe('<img src=x onerror=alert(1)>');
    expect(widget.launcher.querySelector('img')).toBeNull();
  });
});

describe('the embed snippet', () => {
  function script(attributes: Record<string, string>): Pick<Element, 'getAttribute'> {
    return { getAttribute: (name: string) => attributes[name] ?? null };
  }

  it('turns data-theme and data-lang into element attributes, and nothing else', () => {
    expect(
      snippetAttributes(
        script({ 'data-theme': 'dark', 'data-lang': ' ru ', 'data-launcher': 'icon' }),
      ),
    ).toEqual([
      ['theme', 'dark'],
      ['lang', 'ru'],
    ]);
  });

  it('leaves out unknown values and absent settings', () => {
    expect(snippetAttributes(script({ 'data-theme': 'blue' }))).toEqual([]);
    expect(snippetAttributes(script({ 'data-lang': '  ' }))).toEqual([]);
    expect(snippetAttributes(null)).toEqual([]);
  });
});

describe('a price from', () => {
  it('puts the word where the language puts it', async () => {
    const { formatPrice } = await import('../src/ui/price');
    const item = { price: { amount: '1000', currency: 'JPY' }, priceFrom: true };
    expect(formatPrice(item)).toBe('from 1000 JPY');
    applyLanguage('ja');
    expect(formatPrice(item)).toBe('1000 JPYから');
    applyLanguage('ru');
    expect(formatPrice(item)).toBe('от 1000 JPY');
  });
});

describe('the language on the page', () => {
  it("an element's own lang wins over the page's", async () => {
    const { defineAskrElement } = await import('../src/ui/element');
    defineAskrElement(window, () => {
      throw new Error('no client: the element has no store');
    });
    document.documentElement.lang = 'de';
    const widget = document.createElement('askr-chat');
    widget.setAttribute('lang', 'ru');
    document.body.append(widget);
    expect(widget.shadowRoot?.querySelector('.launcher-label')?.textContent).toBe('Спросить ИИ');
    widget.remove();
    const paged = document.createElement('askr-chat');
    document.body.append(paged);
    expect(paged.shadowRoot?.querySelector('.launcher-label')?.textContent).toBe('KI fragen');
    paged.remove();
    document.documentElement.lang = '';
  });
});

describe('the embed snippet language', () => {
  it('keeps only a language the widget speaks', () => {
    const script = (value: string) => ({
      getAttribute: (name: string) => (name === 'data-lang' ? value : null),
    });
    expect(snippetAttributes(script('pt-BR'))).toEqual([['lang', 'pt']]);
    expect(snippetAttributes(script('nl'))).toEqual([]);
  });
});

describe('two widgets, two languages', () => {
  it('each takes its own language back before it draws', () => {
    const russian = view(['ru']);
    view(['en']);
    expect(STRINGS.addToCart).toBe('Add to cart');
    russian.update({ phase: 'ready', branding: true, turns: [] });
    expect(STRINGS.addToCart).toBe('В корзину');
  });

  it('marks the status, the composer and the footer with its language', () => {
    const widget = view(['ja']);
    for (const selector of ['.status', '.composer', '.footer', '.header']) {
      expect(widget.panel.querySelector<HTMLElement>(selector)?.lang, selector).toBe('ja');
    }
  });
});

describe('a price from, in the languages that put the word after it', () => {
  it.each([
    ['zh', '1000 JPY 起'],
    ['ko', '1000 JPY부터'],
    ['de', 'ab 1000 JPY'],
  ])('%s', async (language, expected) => {
    const { formatPrice } = await import('../src/ui/price');
    applyLanguage(language);
    expect(formatPrice({ price: { amount: '1000', currency: 'JPY' }, priceFrom: true })).toBe(
      expected,
    );
  });
});
