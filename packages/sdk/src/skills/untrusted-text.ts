/**
 * Flattening text somebody else wrote.
 *
 * A provider's refusal, a script's stderr, an upstream's error body: all of it
 * ends up on an operator's terminal, in a structured log, or in front of a
 * customer, and none of it can be trusted to be one plain line. The rules are
 * the same everywhere, so they live in one place: no C0/C1 controls, no Unicode
 * format marks, no newline to turn one log line into two, and no half of a
 * character left behind by a cut.
 */

/**
 * Format characters: invisible, and survivors of control-stripping. The class
 * covers what someone would reach for to make a line read as something other
 * than what it says - direction overrides and isolates, zero-width joiners, the
 * byte-order mark, the tag block used to smuggle text past a human reader -
 * without this file having to enumerate them.
 */
export const UNICODE_FORMAT_MARKS = /\p{Cf}/gu;

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
 * Drop a high surrogate a cut separated from its pair. Half a character is not
 * something to hand a log file, a terminal or a JSON encoder: it is not valid
 * UTF-8, and what survives the encoding is a replacement character at best.
 */
export function withoutDanglingSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * One plain paragraph: controls to spaces, format marks gone, runs of
 * whitespace collapsed, trimmed.
 *
 * Marks are stripped after controls and before the whitespace collapse: the
 * byte-order mark is both a mark and whitespace, and collapsing first would
 * leave it as a space nothing removes.
 */
export function flattenUntrusted(text: string): string {
  return withoutControlCharacters(text)
    .replace(UNICODE_FORMAT_MARKS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * At most `maxChars` CHARACTERS, with an ellipsis when something was cut.
 *
 * Counting characters rather than UTF-16 code units is what keeps an emoji at
 * the boundary from being halved.
 */
export function clipToCharacters(text: string, maxChars: number): string {
  const characters = [...text];
  if (characters.length <= maxChars) {
    return text;
  }
  return `${characters
    .slice(0, maxChars - 1)
    .join('')
    .trimEnd()}…`;
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
