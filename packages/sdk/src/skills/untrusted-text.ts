/**
 * Flattening text somebody else wrote.
 *
 * A provider's refusal, a script's stderr, an upstream's error body: all of it
 * ends up on an operator's terminal, in a structured log, or in front of a
 * customer, and none of it can be trusted to be one plain line. The rules are
 * the same everywhere, so they live in one place: no C0/C1 controls, no
 * line-reversing format marks, no newline to turn one log line into two, and no
 * half of a character left behind by a cut.
 */

/** Zero-width joiner and non-joiner - see `withoutFormatMarks`. */
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

/**
 * Safe to share despite the `g` flag: `String.prototype.replace` sets
 * `lastIndex` to 0 before and after a global regex, and this is its only use.
 */
const FORMAT_MARKS = /\p{Cf}/gu;

/** Every C0 and C1 control character becomes a space. */
export function withoutControlCharacters(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }
  return out;
}

/**
 * Strip the format characters that let a line read as something other than what
 * it says: direction overrides and isolates, the byte-order mark, the tag block
 * used to smuggle text past a human reader.
 *
 * `\p{Cf}` covers those without enumerating them, but it also covers ZWJ and
 * ZWNJ, which are load-bearing rather than deceptive: ZWNJ changes which word a
 * Persian or Urdu sentence spells, and ZWJ is what makes one family emoji out of
 * four people. Those two are kept; a refusal written in Persian should reach its
 * customer spelled the way the provider wrote it.
 *
 */
export function withoutFormatMarks(text: string): string {
  return text.replace(FORMAT_MARKS, (mark) => (mark === ZWJ || mark === ZWNJ ? mark : ''));
}

/**
 * Drop a high surrogate a cut separated from its pair. Half a character is not
 * something to hand a log file, a terminal or a JSON encoder: it is not valid
 * UTF-8, and what survives the encoding is a replacement character at best.
 */
export function withoutDanglingSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * One plain paragraph: controls to spaces, deceptive marks gone, runs of
 * whitespace collapsed, trimmed.
 *
 * Marks are stripped after controls and before the whitespace collapse: the
 * byte-order mark is both a mark and whitespace, and collapsing first would
 * leave it as a space nothing removes.
 */
export function flattenUntrusted(text: string): string {
  return withoutFormatMarks(withoutControlCharacters(text)).replace(/\s+/g, ' ').trim();
}

/**
 * The first `maxChars` CHARACTERS, with nothing added.
 *
 * Counting characters rather than UTF-16 code units is what keeps an emoji at
 * the boundary from being halved; the surrogate guard covers the case where the
 * text was already cut by code unit before it got here.
 */
export function takeCharacters(text: string, maxChars: number): string {
  return takeFrom([...text], maxChars);
}

/** `takeCharacters` over an already-split string, so nothing splits it twice. */
function takeFrom(characters: string[], maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  const kept =
    characters.length <= maxChars ? characters.join('') : characters.slice(0, maxChars).join('');
  // On both branches: the text may already have been cut by code unit before it
  // reached here, and appending an ellipsis to half a character is how a lone
  // surrogate ends up in a result event.
  return withoutDanglingSurrogate(kept);
}

/**
 * At most `maxChars` CHARACTERS, with an ellipsis when something was cut.
 *
 * Counting characters rather than UTF-16 code units is what keeps an emoji at
 * the boundary from being halved. A budget of zero or less yields nothing:
 * arithmetic that reaches zero ("what is left of the line") must not come back
 * with the whole input.
 */
export function clipToCharacters(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  const characters = [...text];
  if (characters.length <= maxChars) {
    return withoutDanglingSurrogate(text);
  }
  if (maxChars === 1) {
    return '…';
  }
  return `${takeFrom(characters, maxChars - 1).trimEnd()}…`;
}

/**
 * The index of the first non-whitespace character at or after `from`, or -1.
 * Used instead of `slice().trimStart()` so a megabyte of stdout is not copied
 * to find where its first word starts.
 */
export function firstContentIndex(text: string, from = 0): number {
  const scan = /\S/g;
  scan.lastIndex = from;
  return scan.exec(text)?.index ?? -1;
}
