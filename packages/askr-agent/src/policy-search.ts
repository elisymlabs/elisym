import type { Policy } from '@elisym/askr';
import { tokenize } from './catalog/store-catalog';

/** Policies one search returns at most. */
export const MAX_POLICY_RESULTS = 3;
/** Policy text one search returns at most, shared by its results. */
export const POLICY_RESULT_CHARS = 12_000;
/** Two words of at least this many characters match when one starts the other. */
const STEM_MIN_CHARS = 4;
/** Characters the shorter word may have past what both share: returns / returned. */
const STEM_SLACK_CHARS = 2;
/** Characters the longer word may have past what both share: ship / shipping, not internet / international. */
const STEM_TAIL_CHARS = 4;
/** What stands between two passages of a policy that were not next to each other. */
export const PASSAGE_GAP = '[...]';
const PASSAGE_SEPARATOR = '\n\n';

/**
 * Whether two words are the same word for policy search: equal, or one a
 * form of the other (`return`, `returns`, `returned`; the same in any language).
 * Words shorter than four characters match only exactly.
 */
export function wordsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter < STEM_MIN_CHARS) {
    return false;
  }
  let shared = 0;
  while (shared < shorter && left[shared] === right[shared]) {
    shared += 1;
  }
  return (
    shared >= Math.max(STEM_MIN_CHARS, shorter - STEM_SLACK_CHARS) &&
    longer - shared <= STEM_TAIL_CHARS
  );
}

/** How many of the query's words the text has, each counted once. */
function matchedWords(query: readonly string[], text: string): number {
  const words = [...new Set(tokenize(text))];
  return query.filter((term) => words.some((word) => wordsMatch(term, word))).length;
}

/**
 * The policies that answer a query best, at most `limit`: by how many query
 * words each one's slug, title and text has; title words break a tie. A policy
 * with none of them is left out.
 */
export function rankPolicies(
  policies: readonly Policy[],
  query: readonly string[],
  limit: number,
): Policy[] {
  return policies
    .map((policy, index) => ({
      policy,
      index,
      score: matchedWords(query, `${policy.slug} ${policy.title} ${policy.body}`),
      titleScore: matchedWords(query, `${policy.slug} ${policy.title}`),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.titleScore - left.titleScore || left.index - right.index,
    )
    .slice(0, limit)
    .map((entry) => entry.policy);
}

/** A piece of a policy, and what joins it to the piece before it when both are kept. */
interface Piece {
  text: string;
  glue: string;
}

/** A piece is at most this share of the budget, so one long list or paragraph never fills it. */
const PIECE_BUDGET_DIVISOR = 3;
/** ...and never shorter than this, so a small budget still gets whole sentences. */
const MIN_PIECE_CHARS = 200;
/** The least room worth filling with the start of a piece that does not fit whole. */
const MIN_TAIL_CHARS = 40;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
/** How a piece too long is split, in turn: by line, then by sentence, then cut. */
const SPLITS: ReadonlyArray<{ pattern: RegExp; glue: string }> = [
  { pattern: /\n/, glue: '\n' },
  { pattern: /(?<=[.!?。！？])\s+/u, glue: ' ' },
];

/** `text` in pieces of at most `maxPiece` characters, split as `SPLITS` says from `level` on. */
function split(text: string, maxPiece: number, level: number): Piece[] {
  if (text.length <= maxPiece) {
    return [{ text, glue: '' }];
  }
  const rule = SPLITS[level];
  if (rule === undefined) {
    const cuts: Piece[] = [];
    let start = 0;
    while (start < text.length) {
      const end = cutPoint(text, start + maxPiece);
      cuts.push({ text: text.slice(start, end), glue: '' });
      start = end;
    }
    return cuts;
  }
  const pieces: Piece[] = [];
  let current = '';
  const flush = () => {
    if (current !== '') {
      pieces.push({ text: current, glue: pieces.length === 0 ? '' : rule.glue });
      current = '';
    }
  };
  for (const unit of text.split(rule.pattern)) {
    if (unit.trim() === '') {
      continue;
    }
    if (unit.length > maxPiece) {
      flush();
      // The first of its pieces follows the unit before at this level; the rest keep their own
      // glue (none between the cuts of one long word run).
      for (const [index, piece] of split(unit, maxPiece, level + 1).entries()) {
        pieces.push(index === 0 && pieces.length > 0 ? { ...piece, glue: rule.glue } : piece);
      }
      continue;
    }
    if (current === '') {
      current = unit;
    } else if (current.length + rule.glue.length + unit.length <= maxPiece) {
      current = `${current}${rule.glue}${unit}`;
    } else {
      flush();
      current = unit;
    }
  }
  flush();
  return pieces;
}

/**
 * Where to cut `text` at or before `at`, never between the two halves of a
 * character outside the BMP (an emoji): a lone half is invalid text an LLM API
 * may refuse. Always past 0 for a positive `at`, so a cut loop moves on.
 */
function cutPoint(text: string, at: number): number {
  if (at >= text.length) {
    return text.length;
  }
  const before = text.charCodeAt(at - 1);
  const isHighHalf = before >= HIGH_SURROGATE_FIRST && before <= HIGH_SURROGATE_LAST;
  return isHighHalf && at > 1 ? at - 1 : at;
}

/** The start of `text` within `maxChars`, cut after its last whole word there when it has one. */
function headOf(text: string, maxChars: number): string {
  const head = text.slice(0, cutPoint(text, maxChars));
  const lastSpace = head.search(/\s\S*$/);
  return lastSpace > 0 ? head.slice(0, lastSpace) : head;
}

/**
 * A policy's pieces: its paragraphs, a heading kept with the paragraph under
 * it, and a paragraph over `maxPiece` split by line, then sentence.
 */
function piecesOf(body: string, maxPiece: number): Piece[] {
  const paragraphs: string[] = [];
  let heading = '';
  for (const block of body.split(/\n[^\S\n]*\n/)) {
    const text = block.trim();
    if (text === '') {
      continue;
    }
    if (/^#{1,6}\s/.test(text) && !text.includes('\n')) {
      heading = heading === '' ? text : `${heading}\n${text}`;
      continue;
    }
    paragraphs.push(heading === '' ? text : `${heading}\n${text}`);
    heading = '';
  }
  if (heading !== '') {
    paragraphs.push(heading);
  }
  return paragraphs.flatMap((paragraph) =>
    split(paragraph, maxPiece, 0).map((piece, index) =>
      index === 0 ? { ...piece, glue: PASSAGE_SEPARATOR } : piece,
    ),
  );
}

/**
 * A policy's text within `maxChars`. A longer policy keeps the pieces (its
 * paragraphs, a long one split by line or sentence) with the most query words,
 * then the ones from its start that still fit, in their own order, with `[...]`
 * where it skips; with no query it keeps the start.
 */
export function policyPassage(body: string, query: readonly string[], maxChars: number): string {
  // The length is judged on the text as the fence will show it, with one kind of line end.
  const text = body.normalize('NFKC').replace(/\r\n?/g, '\n');
  if (text.length <= maxChars) {
    return text;
  }
  const pieces = piecesOf(
    text,
    Math.max(MIN_PIECE_CHARS, Math.floor(maxChars / PIECE_BUDGET_DIVISOR)),
  );
  const ranked = pieces
    .map((piece, index) => ({ index, score: matchedWords(query, piece.text) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  // What each kept piece shows: all of it, or for the last one filled in, as much as fits.
  const kept = new Map<number, string>();
  // Each kept piece may bring a gap marker and two separators; one more gap may close the text.
  const reserve = PASSAGE_GAP.length + PASSAGE_SEPARATOR.length * 2;
  let used = PASSAGE_GAP.length + PASSAGE_SEPARATOR.length;
  for (const entry of ranked) {
    const pieceText = pieces[entry.index]?.text ?? '';
    const length = pieceText.length + reserve;
    if (used + length <= maxChars) {
      kept.set(entry.index, pieceText);
      used += length;
    } else if (entry.score === 0) {
      // The rest match nothing: they fill in from the start and stop at the first that does
      // not fit, so the text read is one piece, not scraps from all over the policy. That one
      // shows what still fits of it, up to its last whole word there.
      const room = maxChars - used - reserve;
      if (room >= MIN_TAIL_CHARS) {
        kept.set(entry.index, headOf(pieceText, room));
      }
      break;
    }
  }
  if (kept.size === 0) {
    // Not even one piece fits (a budget of a few hundred characters): the start of the best one,
    // marked as cut when there is room for the mark.
    const best = pieces[ranked[0]?.index ?? 0]?.text ?? '';
    const mark = `${PASSAGE_SEPARATOR}${PASSAGE_GAP}`;
    return maxChars > mark.length * 2
      ? `${headOf(best, maxChars - mark.length)}${mark}`
      : headOf(best, maxChars);
  }
  let passage = '';
  let previous = -1;
  let whole = true;
  for (const [index, piece] of pieces.entries()) {
    const shown = kept.get(index);
    if (shown === undefined) {
      continue;
    }
    // A gap after a piece shown cut too, even when the next one is kept: text is missing there.
    if (index !== previous + 1 || !whole) {
      passage += passage === '' ? PASSAGE_GAP : `${PASSAGE_SEPARATOR}${PASSAGE_GAP}`;
      passage += `${PASSAGE_SEPARATOR}${shown}`;
    } else {
      passage += passage === '' ? shown : `${piece.glue}${shown}`;
    }
    whole = shown === piece.text;
    previous = index;
  }
  if (previous !== pieces.length - 1 || !whole) {
    passage += `${PASSAGE_SEPARATOR}${PASSAGE_GAP}`;
  }
  return passage;
}

/**
 * Passages of `bodies` sharing `totalChars`, in their order. The shortest is
 * served first, so what a short policy leaves unused goes to the longer ones.
 */
export function passagesWithin(
  bodies: readonly string[],
  query: readonly string[],
  totalChars: number,
): string[] {
  const passages: string[] = bodies.map(() => '');
  const order = bodies
    .map((body, index) => ({ index, length: body.length }))
    .sort((left, right) => left.length - right.length || left.index - right.index);
  let remaining = totalChars;
  for (const [position, entry] of order.entries()) {
    const share = Math.floor(remaining / (order.length - position));
    const passage = policyPassage(bodies[entry.index] ?? '', query, share);
    passages[entry.index] = passage;
    remaining -= passage.length;
  }
  return passages;
}
