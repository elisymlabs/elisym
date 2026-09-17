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
 * Safe to share despite the `g` flag because every use below goes through
 * `String.prototype.replace`, which sets `lastIndex` to 0 before and after a
 * global regex. A `.test()` or `.exec()` on it would not be safe.
 */
const FORMAT_MARKS = /\p{Cf}/gu;

/** Every C0 and C1 control character becomes a space. */
export function withoutControlCharacters(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    const isControl = code !== undefined && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
    out += isControl ? ' ' : character;
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
 * Strip EVERY format character, joiners included.
 *
 * For text that will be COMPARED rather than read: the x402 driver masks a
 * customer's input out of an upstream's echo by matching it byte for byte, and
 * an upstream that re-emits `ja<ZWJ>ne@example.com` must collapse back to what
 * the customer sent or the mask misses it and the address reaches the log.
 */
export function withoutAnyFormatMarks(text: string): string {
  return text.replace(FORMAT_MARKS, '');
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

/** Take at most `maxChars` characters from an already-split string. */
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
 * Flatten text that will be COMPARED rather than read.
 *
 * Two deliberate differences from `flattenUntrusted`: control characters are
 * DELETED instead of spaced, and every format mark goes, joiners included. The
 * x402 driver masks a customer's input out of an upstream's echo by matching it
 * byte for byte, so an upstream re-emitting `ja<0x01>ne` or `ja<ZWJ>ne` has to
 * collapse back to what the customer sent or the mask misses it and the address
 * reaches the operator's log. Tab and newline survive as whitespace, so two
 * words on separate lines do not weld together before the collapse.
 */
export function flattenForComparison(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    const isDeletableControl =
      code !== undefined &&
      ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f));
    if (!isDeletableControl) {
      out += character;
    }
  }
  return withoutAnyFormatMarks(out).replace(/\s+/g, ' ').trim();
}

/**
 * One bounded, single-line excerpt of text somebody else wrote.
 *
 * The only way anything in this repository should quote untrusted text, so the
 * three parts stay together: slice BEFORE flattening (the input can be a
 * megabyte and flattening walks every code point), drop a surrogate the raw
 * slice may have separated, then clip by character with an ellipsis. The 8x
 * allowance covers what whitespace collapse can shorten.
 */
export function excerptUntrusted(text: string, maxChars: number): string {
  const window = maxChars * 8;
  const windowed = flattenUntrusted(withoutDanglingSurrogate(text.slice(0, window)));
  // The window is a fast path, not a guarantee: whitespace collapses by an
  // unbounded factor, so 3200 newlines ahead of the real sentence leave the
  // window holding nothing - or, worse, its first letter. Any SHORT result from
  // a text that outran the window means the window was the limit rather than
  // the content, so pay for the whole thing once.
  const flattened =
    [...windowed].length < maxChars && text.length > window ? flattenUntrusted(text) : windowed;
  return clipToCharacters(flattened, maxChars);
}
