/**
 * The element attributes the embed snippet's `data-*` settings become: `data-theme`
 * (light or dark) and `data-lang` (the widget's language). Anything else, or an unknown
 * value, is left out.
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
  return attributes;
}
