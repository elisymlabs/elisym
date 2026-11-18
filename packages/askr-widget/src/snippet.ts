/**
 * The element attributes the embed snippet's `data-*` settings become: `data-theme`
 * (light or dark), `data-lang` (the widget's language) and `data-launcher="icon"` (the mark
 * without its label). Anything else, or an unknown value, is left out.
 */
export function snippetAttributes(
  script: Pick<Element, 'getAttribute'> | null,
): Array<[string, string]> {
  const attributes: Array<[string, string]> = [];
  const theme = script?.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    attributes.push(['theme', theme]);
  }
  const language = script?.getAttribute('data-lang')?.trim();
  if (language) {
    attributes.push(['lang', language]);
  }
  if (script?.getAttribute('data-launcher') === 'icon') {
    attributes.push(['launcher', 'icon']);
  }
  return attributes;
}
