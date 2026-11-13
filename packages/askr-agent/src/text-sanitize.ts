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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ids too short or too plain to strip: "Step (1)", "(m)" are not product ids. */
function stripsAsId(id: string): boolean {
  return id.length > 2 && !/^\d+$/u.test(id);
}

/**
 * Drop a known product or variant id in parentheses from model-written text: "the Trek 45 l
 * (pack-45)", "(id: pack-45)", "(sku: scarf-red)". Products are named, never id'd. Anything else
 * in parentheses stays ("(ID: passport)", "(Handle: oak)"). Run after sanitizeAnswerText, so
 * NFKC has folded full-width parentheses and invisible characters are gone.
 */
export function stripProductIds(text: string, ids: Iterable<string>): string {
  if (!text.includes('(')) {
    return text;
  }
  let stripped = text;
  let lower = text.toLowerCase();
  for (const id of ids) {
    if (!stripsAsId(id) || !lower.includes(`${id.toLowerCase()})`)) {
      continue;
    }
    const mention = String.raw`\((?:(?:id|sku)[ \t]?:[ \t]?)?${escapeRegExp(id)}\)`;
    // The space before goes with it; at a line start, the space after does.
    stripped = stripped.replace(
      new RegExp(String.raw`[ \t]${mention}|^${mention}[ \t]?|${mention}`, 'gimu'),
      '',
    );
    lower = stripped.toLowerCase();
  }
  return stripped === text ? text : stripped.trim();
}
