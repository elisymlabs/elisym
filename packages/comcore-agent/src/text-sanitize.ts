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
  '[': '［',
  ']': '］',
};

export function sanitizeAnswerText(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .replace(/[<>[\]]/g, (character) => LOOKALIKES[character] ?? '')
    .trim();
}
