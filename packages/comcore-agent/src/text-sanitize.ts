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

export function sanitizeAnswerText(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .replace(/[<>[\]]/g, (character) => LOOKALIKES[character] ?? '')
    .trim();
}
