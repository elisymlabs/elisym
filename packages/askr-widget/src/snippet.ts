import { supportedLanguage } from './ui/strings';

/**
 * The element attributes the embed snippet's `data-*` settings become: `data-theme`
 * (light or dark) and `data-lang` (a language the widget speaks, as its two-letter code).
 * Anything else, or a value the widget does not know, is left out.
 */
export function snippetAttributes(
  script: Pick<Element, 'getAttribute'> | null,
): Array<[string, string]> {
  const attributes: Array<[string, string]> = [];
  const theme = script?.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    attributes.push(['theme', theme]);
  }
  const language = supportedLanguage(script?.getAttribute('data-lang'));
  if (language !== undefined) {
    attributes.push(['lang', language]);
  }
  return attributes;
}
