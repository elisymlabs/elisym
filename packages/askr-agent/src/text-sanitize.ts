import { stripInvisible } from './fence';

/**
 * The 4.3 markdown subset for model-written text: no raw HTML, no links, no
 * images. Pattern-matching links is fragile (balanced or escaped brackets,
 * reference definitions in quotes and lists), so the characters that build
 * them never reach the widget: square and angle brackets are swapped for
 * lookalikes. URLs stay as plain text; the only clickable links are cards.
 */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '<': '‹',
  '>': '›',
  // Mathematical white square brackets: unlike fullwidth ones, NFKC leaves them as they are,
  // so no later normalization can fold them back into a link.
  '[': '\u27e6',
  ']': '\u27e7',
};

/** A product id written in parentheses ("(id: pack-45)"): products are named, never id'd. */
const ID_MENTION_RE = /[ \t]*\(\s*(?:id|sku|handle)\s*:\s*[^()\n]{1,80}\)/giu;

export function sanitizeAnswerText(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .replace(ID_MENTION_RE, '')
    .replace(/[<>[\]]/g, (character) => LOOKALIKES[character] ?? '')
    .trim();
}

/** Drop a known product id in parentheses ("the Trek 45 l (pack-45)"): the text names products. */
export function stripProductIds(text: string, ids: Iterable<string>): string {
  let stripped = text;
  for (const id of ids) {
    if (stripped.includes(`(${id})`)) {
      stripped = stripped.split(` (${id})`).join('').split(`(${id})`).join('');
    }
  }
  return stripped;
}
