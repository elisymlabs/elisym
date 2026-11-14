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

/**
 * A bracketed span once the brackets are swapped: those brackets are reserved for fences and
 * history notes ("[shown, in order: ...]"), so a model that copies one into its answer loses it.
 * Linear: a span neither nests nor holds another bracket.
 */
const BRACKETED_RE = /[ \t]?\u27e6[^\u27e6\u27e7]*\u27e7/gu;

export function sanitizeAnswerText(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .replace(/[<>[\]]/g, (character) => LOOKALIKES[character] ?? '')
    .replace(BRACKETED_RE, '')
    .trim();
}

/** Ids a model may have written in its text, normalized as the text is (see normalizeId). */
export interface IdsToStrip {
  /** Stripped when written alone in parentheses: "(pack-45)". */
  bare: ReadonlySet<string>;
  /** Stripped after an id: or sku: label: "(id: pack-45)", "(sku: black)". */
  labeled: ReadonlySet<string>;
}

/** An id as the sanitized text would show it: NFKC, no invisible characters, lookalike brackets, lowercased. */
function normalizeId(id: string): string {
  return sanitizeAnswerText(id).toLowerCase();
}

/** Too short or all digits: "Step (1)", "(xl)", "(12345)" are no product ids. */
function stripsAsId(id: string): boolean {
  return id.length > 2 && !/^\d+$/u.test(id);
}

/** A variant id that is a plain word ("black") is stripped only with a label: "(black)" is a color. */
const ID_SHAPED_RE = /[\d\-_.:]/u;

/**
 * The ids to strip from model-written text: product ids written alone or labeled, variant ids
 * written alone only when they look like ids (a digit or a separator), labeled always.
 */
export function idsToStrip(productIds: Iterable<string>, variantIds: Iterable<string>): IdsToStrip {
  const bare = new Set<string>();
  const labeled = new Set<string>();
  for (const id of productIds) {
    const normalized = normalizeId(id);
    if (stripsAsId(normalized)) {
      bare.add(normalized);
      labeled.add(normalized);
    }
  }
  for (const id of variantIds) {
    const normalized = normalizeId(id);
    if (stripsAsId(normalized)) {
      labeled.add(normalized);
      if (ID_SHAPED_RE.test(normalized)) {
        bare.add(normalized);
      }
    }
  }
  return { bare, labeled };
}

/** Something in parentheses that may be an id, with an optional id: or sku: label. */
const ID_MENTION_RE = /([ \t])?\((?:(id|sku)[ \t]?:[ \t]?)?([^()\n]{3,128})\)/giu;

/**
 * Drop a known product or variant id in parentheses from sanitized text: "the Trek 45 l
 * (pack-45)", "(id: pack-45)", "(sku: scarf-red)". Products are named, never id'd. Anything else
 * in parentheses stays ("(ID: passport)", "(black)"). One linear scan, each candidate looked up
 * in the set. The space before goes with a mention; at a line start, the space after does.
 */
export function stripProductIds(text: string, ids: IdsToStrip): string {
  if (!text.includes('(')) {
    return text;
  }
  let kept = '';
  let from = 0;
  for (const match of text.matchAll(ID_MENTION_RE)) {
    const candidate = (match[3] ?? '').trim().toLowerCase();
    if (!(match[2] === undefined ? ids.bare : ids.labeled).has(candidate)) {
      continue;
    }
    const start = match.index;
    let end = start + match[0].length;
    const lineStart = match[1] === undefined && (start === 0 || text[start - 1] === '\n');
    if (lineStart && (text[end] === ' ' || text[end] === '\t')) {
      end += 1;
    }
    kept += text.slice(from, start);
    from = end;
  }
  return from === 0 ? text : `${kept}${text.slice(from)}`.trim();
}
