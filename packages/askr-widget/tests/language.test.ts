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
    expect(widget.panel.lang).toBe('ru');
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
    expect(stored.launcher.getAttribute('aria-label')).toBe(
      "Discuter avec l'assistant de la boutique",
    );
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
